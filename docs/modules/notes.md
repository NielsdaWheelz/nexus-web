# authored notes

titled pages, one-block notes, annotated highlights and undirected links form
one account-scoped authored graph. the same local query and commit owners serve
writing online and offline. source downloads, chat, imports and account operations
retain their separate owners.

## page register

large notes registers keep an identity-only order in the account's open
sqlite connection before presenting a sparse description. a reachable visit
retains its captured order. if the saved row disappears, back resolves the
next surviving captured row, then the preceding one, against the current
description. current membership authorizes the returned identity. visit and
document retirement release their observations.

## journal

`/daily` resolves the account's current civil date; `/daily/:date` opens the
continuous journal at that date. newest dates precede older dates; writing keeps
each page's own relationship order. `/pages/:id` is a separate standalone view.
the local `daily_index` orders visible daily pages, recorded work dates, the
requested arrival and any presented retained editors. civil date is the key.
completion-only and unwritten dates may have a null page ref. reading, focus
and scrolling leave storage unchanged. canonical daily bindings, including
historical refs, remain authoritative.

one pane coordinates dates, one controller owns each day, and one memento owns
programmatic scrolling. the journal's variable-height date geometry composes
immutable outline row frames. resize, projection and binding reconciliation
capture the prior eye line before publishing geometry; user input cancels stale
restoration. a child frame refines only its enclosing logical date; placement
waits for measured extents to reach the committed geometry. end on the
focused pane scrollport reveals the oldest civil date. explicit date
activation reveals; back/resume restore the saved visit. workspace labels and
recents describe the arrival date without title
reads or rewriting the destination to a standalone page.

programmatic scroll positions reach the date virtualizer through its offset
observer before range planning. geometry and admission use the same scroll
position; ordinary scroll events keep the library's existing observer.
day heights include their spacing, but trailing inter-day spacing is not readable
content when choosing the eye line or visible date.

a cold journal day first admits one row and its existing boundary proof, then
fills through ordinary viewport demand. standalone roots keep their 32-row
bootstrap. boundary resources remain complete; the row limit is not a byte cap.

the band above the agenda names the account's current date, when known. if
today is the first day, its accessible heading stays in the leaf and its menu
moves to the band. a later-dated first page leaves today's leaf heading in view.
all day headings share metrics while their inner date names can change size. the
navigation row names the day under the scroll edge and yields while its date is
in the scrollport. pressing the name opens the calendar. `today` returns to the band. dates use weekday, day and month, adding the year outside this year.

inline journal titles are italic and keep the content editor's six-line extent.
empty titles hide after settled blur. trailing space holds a break between days.
day reading controls reveal on focus.

scrolling attaches views on demand while retaining a day's pending owner and
finite undo history. commands, selection and history remain day-local. native
selection and clipboard ingress refuse unloaded gaps before partial edits or
clipboard publication. a focused nonediting day article holds a stable reading
interval; earlier/later-writing controls advance it explicitly. editing admits
fresh local proof before releasing the hold. deliberate departure never waits
for a read. the same renderer serves reading and writing.

the hold freezes the displayed contiguous interval and its exact neighboring
proofs. viewport prefetch cannot move those continuation boundaries. advancing
may revisit a live preview. fresh admission follows the captured neighbor's
identity, or its surviving order after deletion. concurrent insertions or moves
may require revisiting the day; a reading hold is not an archive snapshot.

small date orders return their keys in the description. a large description
gives the total extent, the first dates, the ranks of the requested dates
and a 31-bit occupancy mask per occupied civil month. the masks cover the
full order, so their size grows with occupied months. page refs and writing
arrive by bounded rank ranges. a saved date can be located at the same
revision.

a native hold keeps the captured date order and measured extent. when the
account advances, the current register supplies details for surviving
dates by their new rank. a date awaiting a current detail occupies its full
reserved block as a heading. only admitted days may resolve a page binding
or refine their estimate. the memento expands the captured order when it
needs saved anchor keys. active selections and rich bodies have no hard
total-memory bound.

the ui, worker and packaged native plans share the same query contract and
android's 16-mib result limit. a change to the account store revision
invalidates descriptions and fences outstanding ranges.

## work

a task or daily habit is the same note with optional structured work metadata.
`[ ] ` at the beginning of typed prose or `make task` designates it; `repeat daily`
selects daily repetition. paste and code retain literal text. source return creates
ordinary writing. graph operations and independent child tasks retain their
existing contracts.

work designation, one task completion date and each habit date are separate stamped
registers. false habit checks remain causal clearing facts. capture keeps the first
designation stamp and supplies deterministic ordering, including offline captures.
normal conversion refuses currently recorded history; concurrent conversions retain
both typed histories and the winning designation controls current behavior. disabling
tracking retains dates. unlink changes placement; deletion hides work and restoration
returns it. text always uses the note's current wording.

`work_pending`, `work_completed` and `habits` describe the complete order of
one local revision. large registers load visible rank ranges and resolve saved
occurrences directly. unfinished tasks and today's unchecked habits share
numeric capture order, with replica and ref ties. the pending view places
retained editors and completion receipts at the matching gap in that order.
an already retained task refreshes its label and action facts through
`work_row`. the editor reads its own canonical writing separately.
large completed days keep seekable rows inside the journal. register items
carry bounded labels. a mounted row reads an elided label on demand, using
already-open writing when available. the habit register carries whether
repetition is active. its visible rows read positive checks for the selected year.
configured habits and non-configured notes with positive habit history
contribute keys from separate partial indexes.

large work and habit registers retain their order in the account's local
sqlite connection through native motion. the pane positions a remembered
line from its captured occurrence or ordinal. work translates a displayed
ordinal through its local receipt and editor placements before resolving
the current survivor. historical sections publish the revision of their
own civil-date register.

the journal agenda ends with `add a task`, which opens its capture form in
place. a completion fills the sign immediately. after 600ms from the press,
its receipt replaces the row. an active menu or an editor still in use keeps
the row until released. keyboard completion advances focus. pointer completion
preserves focus through the dwell. a focused sign hands its place to its own
`undo`, and expiry hands focus to a surviving sign or the capture control.

pressing `undo` during the five-second receipt clears the same note and civil
day after its completion commits locally. a refused completion restores its
row. an accepted undo keeps its receipt until the inverse settles, and a
refused inverse offers another five seconds. a pending-work read at or beyond
the command's local revision reconciles the restored or expired row. a day's
settled, nonempty completion read draws one line of linked names with individual
`clear` actions. no query manufactures a page, relationship or daily occurrence.

today uses one account timezone clock. a server-valid zone absent from the
browser's tzdata has no computable day: `useAccountToday()` returns null, its
midnight timer stops, and commands requiring today disable or refuse with a
link to Account. settings remains reachable to change the zone. recorded dates,
ordinary note editing and ledger undo stay readable and usable; no other zone
or day substitutes for the account's. new completions permit today or any past
civil date, including dates before creation. existing dates never rebucket. task
reopening clears its date; retrospective clearing addresses its displayed date;
habit checks remain independent. on an outline row, the nearest dated ancestor
(including its root) decides whether a habit offers today's checkbox. on another
day the habit shows a note dot and its `daily` tail. an unknown account day
leaves the checkbox focusable and unavailable. blank means no record. no deadline, eligibility,
missed-day, streak, score, automatic parent completion or midnight write exists.

derived panes own one visit-scoped outline history; source actions borrow their
outline's history. conditional inverses restore only their expected winning field.
undo survives row removal and never overwrites a subsequently received field.
an inverse against a deleted note does nothing; a direct work gesture against an
unavailable note is refused without consuming the writing queue. source
split retains the original work identity and creates ordinary writing; joining away
a work-bearing source is refused. inline work uses the existing note editor with
hard-break return and focus-traversing tab. focused editors, controls and owned
dialogs retain only their mounted occurrence through completion; departure releases
it. existing row pins own pending writing and menu preparation. stale reads never
authorize new work commands.

`/habits?year=YYYY` summarizes binary checks. its paper heading carries the
year controls. the grid shows weeks in columns, weekdays in rows and one dot per
day. a fill records completion and a ring marks today. the legend follows the
last habit. the header title yields while the paper heading is visible.
activating a date opens that date
in the existing correction dialog; month navigation never writes. year and month
each use one roving keyboard stop. a normal history button remains available on
small screens. stopped habits retain editable history. the store derives the
latest recorded date across all habits. visible rows read positive dates for
the chosen year.

## ownership

- `node/authored` owns the closed body grammar, literal projections, identity,
  causal merge, command preparation, query contracts and sqlite schema.
- `apps/web/src/lib/authored` owns the account worker/store client, durable browser
  storage, native adapter, subscriptions, provisioning and foreground transport.
- android `authored/` owns one serialized bundled sqlite connection and the fixed
  native bridge; account/document admission remains with the native session.
- python `services/authored` owns the account head transaction, bounded node
  helper, canonical postgres state, feed and relational projections. existing
  note/graph/highlight readers consume those projections and semantic visibility.
- editors own their live input and session undo groups. their adapter translates
  actual editor transactions to incremental shared operations, never a stale
  whole-body replacement.

native operations share one admitted dispatcher. requests up to 24 kib of utf8 json
use one inline frame; replies up to 24 kib return bounded inline bytes, while larger
replies return the existing transfer handle and are read without re-execution.
larger requests retain staged framing. both encodings retain the same account,
document, command lease, cancellation and 16 mib result limits; neither retries an
operation after a lost reply.

authored query subscriptions require success and failure callbacks and return one
unsubscribe function. one initial read and subsequent invalidations use those same
owners; adapters do not report failures behind the caller. read surfaces retain
accepted rows on refresh failure and publish recovery outside the content flow;
retry retains the incident, action and accepted same-query prefix until settlement.
account, query and null changes never borrow another read's rows. direct runtime,
reader, media and title subscribers explicitly retain global failure reporting.
standalone authored pane locators retain their canonical title subscriptions. the active
root separately publishes its literal display label through pane chrome; previews
and unfinished input never become acknowledged workspace hints.
`useAuthoredPrefix` owns one revision-consistent paginated read for both the
picker's page-count wrapper and controlled local search. null disables its read;
showing more retains the accepted prefix until its replacement lands.
document loading reads state and revision together. its first successful resource
subscription delivery may reuse that actual snapshot resource only at the exact
same revision, through the ordinary receive/bookkeeping path. the certificate is
consumed once; changed revisions, synthetic pages and prepared documents read
canonical state normally.
the note route and outline share one root-window read. its actual root request
owns paging and branch provenance; descendant windows retain their collectors.
same-account, same-ref canonical root metadata advances by successful revision,
including absence, and survives paging or refresh failure without retiring the
editing host. arrivals and inspection use that exact canonical text; edit-note
delivery waits for the actual editor handle. unknown and unavailable notes do
not admit writing documents. android's existing aggregate window cap also bounds
this canonical note-route read; failures retain their owned read retry.

an accepted `WritingDocument` owns its refresh snapshot and subscription. a failed
refresh retains the same yjs document, undo and text; `retryRead` rearms that read.
account, cached-document and attempt identity fence both success and failure.
modeled local storage errors retain recovery; invariant defects reach the existing
defect boundary. only current successful adoption clears a read incident.

`WritingRuntime` save errors describe uncommitted commands only. their inert
occurrence identity survives retries and presentation changes. one account adapter
offers the exact retry and exports only actual endangered writing, never clean
text from a failed graph operation. locally committed pending synchronization is
already saved and acquires no loss guard. pending outline input remains its own
buffer, export and recovery owner.
while a command is pending, its runtime owns the failure occurrence; a transient
store status cannot create a second stopped-store incident for that command.

branch collectors publish read and admission state into their existing controller
request. row chrome consumes that projection without starting another read. the
existing disclosure slot carries foreground waiting; root waiting uses pane
chrome. ordinary caret movement and routine autosave are silent.
failed admission retains its request, proposal and recovery through selection
and blur. automatic reconciliation resumes deferred healthy proposals only;
explicit retry renews the failed request's navigation lease before admission.

`cd apps/web && bun run gen:authored-helper` bundles `node/authored/helper.ts`
and its shared semantic imports into the shipped `node/authored/helper.mjs`.
`./scripts/test` regenerates into a temporary file and rejects stale bytes.
the frozen migration seed bundle retains its own historical semantics and is
never regenerated from the current helper.

## content and identity

standalone plain-text sharing uses the same `captureToday` command and local store.
its date and note identity freeze on the first explicit press, or come from the
actual native share's capture metadata; retry retains those bytes and the local
commit handle. the share-host `AuthoredProvider` requires an `openWorkspace` action
for sign-in and setup recovery. that action belongs to the document's host, not
the store: actual share activities open main, ordinary share documents open the
workspace. the workspace retains ownership of account retirement and setup cleanup.

one note has one permanent body element and one permanent inline yjs text. its
prosemirror shape is `body{presentation:prose|code}` with text, hard breaks, images
and typed resource embeds. formatting changes attributes and marks, not the outer
identity. code is presentation: marks and visible atoms remain stored. canonical
text and selection offsets derive from the shared projection.

ordinary resources use fresh client uuids. daily identity is account plus local
date; known bindings preserve seeded page ids, unseen days derive uuid5. opening
a day writes nothing. standalone captions and list labels use a date-derived
default for an empty stored title without inserting it into the title crdt.
the journal keeps its date heading separate and hides the blank authored title.
title storage has no display length ceiling.

links are relationships, never ownership. explicit unlink preserves endpoints;
deleting a page, note or highlight never consumes an independent related note.
a highlight owns its single annotation body; ordinary note links confer no
annotation meaning. pdf resizing preserves the highlight id, annotation and links.

the connections companion ranks distinct incoming mention owners by ref. its
large register retains old ranks on the local sqlite connection. a held slice
admits only owners that still mention the target and remain visible. the
companion resolves the captured landing in the current register and mounts
that row before restoring its line on the companion scrollport. later input
and closing the companion retire the placement.

source stubs retain literal references when a source disappears, including a
deleted conversation. source deletion does not unlink the authored graph; a
captured label grants no source access.

## merge and local commit

resource visibility is any touch component greater than the corresponding
observed deletion component. deletion covers the touch vector the command read.
an unseen concurrent edit therefore revives only its addressed resource. link
membership uses the equivalent add/observed-remove rule and endpoint liveness.
explicit unlinks remain removed when an endpoint revives.

scalar selection/color/position registers choose greatest lamport and replica id.
a selection captures publication, geometry, quote and context together. endpoint
order is fractional position then link id; equal-key insertion rekeys only the
observed tie run. receiving and indexing never manufacture a touch.

the register lists visible undated pages by display title under sqlite `NOCASE`,
then ref, using the `resources_register` partial index. the uppercased first code
point heads each run. an empty title files as `untitled page`. `opened here`
shows the first eight distinct visible undated pages from device recents. a filter
hides that group and matches every title by unicode-15 nfc/lower/substring.
through 200 rows, the description returns the full lean order. beyond that it
returns the total, consecutive heading lengths and a 24-row head. the viewport
reads bounded ranks and locates saved references at that revision. long titles
retain their register slot and resolve only when mounted. `New page` opens
an empty focused title on the paper. authored devices store no edit timestamps.

while the register is moving, its captured ranks and heading positions stay
fixed. bounded slices join that order to current visible pages and paint their
current titles. unread or withdrawn rows keep their extent without controls.
release resolves the captured ordinal against current membership before placing
the new view, even when that row was never read during the movement.

one local sql transaction commits touched merge bytes, projections, indexes,
source sequence, store revision and immutable pending change. only durable commit
acknowledges saved writing. uncertain replies reconcile the same source sequence;
stale revisions remerge the frozen intent without allocating another touch.
local acceptance, server acceptance and availability to server tools are distinct
facts; a local save alone promises neither of the latter two.

browser sqlite reports indexeddb aborts as failed local commits. the pinned vfs
patch waits for the actual abort, releases locks and restores its operation
chain. sqlite autocommit decides whether rollback remains necessary. if failed
rollback leaves a transaction active, that connection stops serving reads and
writes; provisional state cannot become an acknowledged save. ordinary aborts
retain retry. a stopped connection requires copying or deliberately discarding
uncommitted writing before restarting its owner.

before returning a local receipt, the runtime merges its committed state into
already open writing documents. subsequent edits therefore see the shared-text
identities they reference; subscription delivery is not a commit barrier. incoming
receipt state does not create another write or text-history item.

`WritingRuntime.admitWriting` reserves one command before publishing canonical
new notes or synchronously changing existing documents. callers declare each
document's origin; the runtime captures those actual yjs mutations and freezes
each new initializer once. asynchronous preparation supplies graph intents only,
using store reads and previously sealed proofs. it must not capture its own
pending documents or submit another writer. graph preparation may retry;
canonical mutation never does. participant captures and pins follow eventual
settlement, while the returned result reports the first failure. a partial
mutation fault retains unsaved writing for copy or deliberate discard and blocks
later commands. unsaved-copy includes open documents queued behind that fault.

an explicit document reopen can supply a fresh nonempty initializer to the same
cached cell; an empty open preserves its pending initializer. the next admitted
command consumes it once. an already admitted command retains its frozen bytes.

local receipts also retain `before`: touch/delete or add/remove vectors per
changed resource or relationship from the successful compare-and-swap prestate. a stale result
replaces that certificate before remerge; an uncertain committed retry retains
the original attempt's certificate. requested absence can certify an empty
vector; an omitted identity supplies no coverage proof. coverage advances each
added replica component only when its prestate touches are already covered or
removed in that exact prestate. this command’s removals cannot supply that proof.
it never imports other prestate lanes or covers a live intervening same-replica
edit merely because text is unchanged.

ordinary notes and inline outline annotations autosave locally from the first
keystroke. selection and reader annotation creation retain their explicit-save
composers; unsubmitted composer text is ephemeral. uncommitted
writing retains the loss guard and retry/copy affordance. committed unsynchronized
writing survives app termination and does not acquire an exit warning.

a first explicit annotation save locks its submitted clone until the reserved command
settles. the existing retained draft owns that lock through navigation; durability
clears the same clone and revision even while its editor is absent. subsequent
body editing uses the ordinary autosave owner.

split copies the observed suffix into a new note and removes only its observed
source ranges. join inserts the observed source at its destination anchor, then
covers the observed source liveness; it never redirects independent source links.
concurrent source edits can revive that source while copied words remain in the
destination. undo/redo uses local-origin crdt and graph inverses; it does not
restore an old body snapshot or overwrite an intervening scalar owner.

## outline interaction

one outline session owns its retained root and one persistent descendant
prosemirror view. standalone panes place the root above its children on the
paper. pages use their native display-sized title textarea. notes use one
always-visible rich-body editor with a leading checkbox when work is enabled. the flat,
ephemeral descendant rows project disclosed occurrences and pending fields; they
never become authored storage. an occurrence uuid survives receipt
adoption and reparenting. resource refs, relationships and placement remain
separate identities, and repeated appearances of one note have separate
displayed baselines. titles use plain shared text and admit no marks or atoms.
the projection reuses the canonical inline grammar without importing row ids or
placement from clipboard content.

`useLocalOutlineRoot` supplies the root editor, its feedback and the descendant
view. the root's mounted attachment publishes its handle and visibility to the
controller. `OutlineController` owns the root document, creation prelude,
admission, shared history and focus requests. root and descendants keep
separate native selections and share undo. the root's displayed baseline counts
against the admission budget. bookmarks carry relative selections.

the pane heading names a page by its title and a note by its first line. it
yields while the paper's opening is in view. enter in the page title focuses
the first row. a note opens directly on its body, or at an inspected passage.
return inserts a hard break in prose and a literal newline in code. root text is
outside child split, join, range selection and arrangement. descendant filtering
preserves the root. an inline day can reveal its empty title for editing, then
fold it after focus leaves and native input settles. opening a latent page
writes nothing. its first title or child edit commits creation with that edit.
`settleNativeInput` reconciles native packets without requiring a query to close;
`canArrange` still fences guarded drafts. structural commands require both.
active native input still refuses settlement. a completed composition transfers
through its existing owner before the command proceeds. if that transfer opens
a new reference query, the current command is refused after ownership changes;
an already active query retains its local history commands.

item text means an occurrence’s own note body or inline page title.
item text is entered by pointer or f2, not sequential tab. each occurrence's
read-only head is its native navigation target; f2 from that target or its own
head controls enters editable item text at the end. a reference head with token
editing enters its token instead. text, embedded content, terminal references
without that capability and an open query never borrow that command. escape selects
an item; a second escape returns to its bullet. native traversal skips item
text in either direction and can return to the admitted root or insertion field.
root text, insertion fields and annotation bodies retain native tab behavior.
idle editable item text reserves tab/shift-tab, the move chord and the fold chord
for outline structure. every arrangement, by key or drop, is one plan over the
topmost selected occurrences, lowered as one batch, one history group and one
undo. a refusal appears at the pane's foot as a plain slip. native links and
buttons keep their own keys.
shift-click across item text or row background selects the inclusive visible
range from a fixed occurrence anchor. only the descendant view's active text
selection supplies a text anchor. root or control focus cannot reuse its
dormant caret. same-row text selection stays native;
modified work-sign clicks also select without toggling. selection excludes root/insertion fields,
keeps embedded scopes separate, refuses paging gaps, and retains exact membership
across incoming updates. it never identifies occurrences by resource ref.
block mode disables native text editing while retaining focus and structural
commands. typing, composition and formatting are inert; return edits the first
selected item at its end. copy writes the topmost occurrences by reference, with
indented plain text beside them; cut copies, then removes them in one gesture.
paste, with items selected or into an empty item, links each copied ref after the
last selected item or above the empty one, skipping pairs already linked under
that parent; plain lines become new notes at their indented depths, the empty item
taking the first. one paste is one batch; copied notes are linked, never
duplicated. plain text click or f2 resumes editing; escape returns to the endpoint
bullet. move up/down takes every selected run, all or nothing, and stops at the
first or last sibling. a destination whose pair already has a visible link moves
that link: a drop onto a parent that already links the item gives that link the
drop's place and removes the source link. alt at release links the item under the
destination as well.
row controls keep the host read-only until pointer, f2 or certified native-tab
entry admits text editing. selection observation never enables editing.
keyboard moves, block-selection counts and history results use the pane's
plain slip. the feedback stage owns its five-second dwell and announcement.
each gesture publishes a fresh occurrence even when its count repeats. a drag
shows the row's words and prospective parent in its ghost.
the existing focus request owns a plain-tab entry certificate while the host is
unfocused. actual native focus installs its authorized insertion caret
synchronously before selection observation; pointer and later keyboard intent
revoke it, and explicit focus replaces it. the same selection notifications retry
an entry held by input ownership; its row, ref, field kind and lease must still
match. native tab still chooses its target.
flat structural moves and return execute once per press; held backward/forward
deletion repeats inside the current field and stops at its boundary. hardware
keyup re-arms deletion. a keyboard without release identity requires a caret tap
or another editing action to re-arm boundary deletion; elapsed time never does.
local writes sequence through the same runtime tail, without a keyboard queue.

the outer projection replaces complete changed rows at row boundaries. isolating
row wrappers never enter the inline input fitter; binding owns inline diffs.
each editor step routes through its own pre-step document to one field. generic
cross-field joins and splits are refused; the structural intent owner performs
them. shared-text identity preserves caret bookmarks. structural history also
records the semantic occurrence placement, so a surviving independent relation
cannot acquire the moved occurrence's identity. newer user intent cancels delayed
focus and targeted window changes; programmatic selection does not cancel its
own operation. append uses the proven absolute tail.

owned direct-reference occurrences in standalone page/note outlines keep their
resource presentation at rest. a completed press in nonlink row space activates
one native `@label` atom; resource links, controls, quote selection, annotations
and descendants keep their own events. the atom has no authored prose document.
its label is generated paint plus an accessible name; native input sees one
indivisible object, without readonly label-text positions for an ime to enter.
plain and rich copying use the model's resource identity and label.
typing, committed composition and textual paste use the existing reference
chooser; its query stays ephemeral. enter with an open chooser only accepts;
without a query it births one sibling even when the target is expanded. escape
cancels the query to the atom, then exits editing. leaving cancels an unaccepted
query. the chooser overlay remains part of the interaction. it anchors to the
active row, flips above when needed and stays within the scrollport and editor.

accepting in an empty, childless body item replaces its incoming link in one
undo group. undo restores that item in place. a pending birth waits for its
link and rechecks the local child proof. a birth whose first attempt failed is
held and retried as words at risk; the accept waits for the retry's link, then
ordinary insertion leaves the item in place beside the reference. the pending
layer holds the first attempt’s outcome until the birth writes its link. an
accept made during that interval observes the outcome even if the row moves
or reconciles. a closed lease writes nothing. a refused replacement keeps its
query open. seeds, roots, nonempty items and parents use ordinary insertion.

replacement retains the original edge until admission, revalidates the frozen
occurrence and edge under the account lease, and allocates before that live edge
before unlinking it in the same command. the current target is a no-op; self,
duplicate and stale targets refuse. deleting the committed atom uses the same
birth admission to replace the edge with a deliberate empty note. each command
has one structural undo group and observes only its owned membership; referenced
resources and their children survive. subtree loss guards precede retirement.
an owned note or page target immediately adopts its ordinary body/title editor,
including after reload; removing that relationship uses the existing row menu.
filtered/read-only scopes, connections and indexes gain no token capability.

outline annotations use the same history from their first keystroke. enter
splits the displayed rich yjs range into a new actual first child, replacing the
selection and preserving unseen source inserts. source delta, newborn and link
share one authored command; undo restores the source and retires the newborn,
and redo reuses its identities. destination, budget and current command authority
are proved before synchronous birth. shift-enter and whole-body code retain
line breaks; inline code marks retain structural splitting. annotation bookmarks
use the highlight ref and occurrence, with the mounted annotation/root handle.
resource-list occurrences activate their child scope before input and retain it
across disclosure; untouched collapsed rows open no documents or controllers.

within the descendant outline, return splits prose at the selection. at the
item's start it births an empty item above and the text keeps its identity; at
the end of an open, loaded parent it births the first child. an empty nested item
outdents first; an empty top-level item stays empty. backward deletion at the
start joins the item into the previous visible row; forward deletion at the end
pulls in the next sibling; deleting an empty item unlinks its occurrence. an item
with proven children (a window proof, shown rows or pending writing beneath)
refuses both, with `remove its children first` or `join its children first`.
while an arrangement is unresolved, boundary deletion and first-child insertion
refuse immediately; they never replay against later typing.
in a body with no such intent, deleting in an empty code body returns it to
prose, one format edit with history boundaries on both sides. it leaves no empty
code body, so a held key stops there. code return remains an in-note break. its native DOM parser preserves literal
newlines; clipboard slices retain their separate existing import policy. block
commands normalize selected ancestors and descendants to topmost occurrences.
indent/outdent plans complete sibling runs against one snapshot, and outdent
adopts the following siblings, so no visible line changes place; removal unlinks
only those roots' incoming relationships. resources, internal links and
independent relationships survive.
the relationship menu still names one exact edge. range removal enters the next
survivor's text start, otherwise the previous survivor's end or empty insertion
field. read-only survivors receive block selection. the removal press remains
fenced through keyup across internal focus transfer, including the same session's
separate root editor.
uncommitted annotation input uses the same loss decision for relationship-menu
unlink and range removal, covering affected edge aliases and their descendants.
the decision is synchronous at the gesture; admitted work still settles, and
drafts keep their existing visit ownership. only actual uncommitted work retains
extra row ancestry; retired clean associations do not expand the editing window.
title return and shift-return enter the root's first item or create the following
item for a title occurrence. pasting literal title text remains separate from
that keyboard command.
text and structure share one session undo order. reference-query text retains its
local editing history while the query owns input.

the existing retained workspace input cell owns pending occurrence metadata and
literal copy text. every accepted field binds its actual canonical document at
synchronous admission. the runtime reserves one command slot before mutation,
seals the real y updates and newborn initializers, and prepares only graph
metadata afterward. following typing, return and undo use those same documents
and their real undo managers; no receipt-time body replay or inverse snapshot
restore is involved. deferred graph preparation waits for a predecessor's
eventual receipt, while its first failure remains visible through the original
error owner. a birth beside an arranging occurrence captures that predecessor's
placement future, while admitting its canonical text and history synchronously.
typing and focus enter the new field before later input; graph preparation uses
the predecessor's resolved parent and anchors. relationship receipts publish only
while they still own the field's link and match its actual endpoint pair. exact
immutable retry stays with the runtime.

range history separates input bookmarks from occurrence placement/proof data.
each gesture pins its selection and predecessor proofs, reserves the existing
runtime tail, and prepares one complete graph batch under its account lease.
canonical metadata checks hidden destination collisions and position allocation
at one revision. queued gestures order their captured, shown siblings by current
stored positions under that command lease; old neighbor bookmarks do not reorder
later births. captured relationship witnesses still own membership changes. a
pending reparent across an unloaded sibling gap refuses instead of guessing.
expected refusal publishes no placements, consumes no sequence,
and never enters the save-failure lane. exact byte/retention limits refuse the
whole command; both stored replay directions must fit the atomic command limit.
replay also reserves within the existing total editing budget before moving its
history group. accepted work uses the existing immutable persistence recovery.

provisional history suspends the captured redo branch until acceptance or
refusal. undo/redo chooses its group synchronously, before waiting for receipts;
an inverse aimed at a refused gesture is a no-op. later real writing still
retires its old redo branch. replay uses stored endpoints and guarded inverses,
preserves independent causal membership and positional ownership, and restores
surviving original selection members. final committed state corrects accepted
placements without claiming independently removed descendants or relationships.
an independently surviving incoming relationship remains visible. semantic
projection repairs a newer selection's missing endpoints without taking focus.
newer meaningful input revokes delayed focus; inert block input does not.
session undo is not persisted.

full roam or obsidian parity is outside this editor's target. excluded behaviors
are cross-pane drag, selection or expand-all beyond one loaded window, synced
fold state, non-contiguous selection, branch paste by value, a separate zoom mode
or zoom chords, and `⌘K` inside the editor. opening an item uses an ordinary pane.

receipt adoption acknowledges only its admission. it never overwrites later
writing, placement or the editing host. canonical settlement also clears the
same retained cell while its pane is absent. hidden history occurrences retain
their displayed causal baselines; redo reuses those baselines rather than
acquiring a newer unrelated frontier.

native packets, composition and reference queries retain their field and
baseline together. incoming projection changes cannot withdraw an owner while
its dom remains protected. commands reconcile prosemirror's own dom observer and
native selection before choosing a field. a composition handoff finishes its
previous owner, then synchronizes the native range before capturing the next.
deferred composition completion cannot release a newer packet or record another
field's edit. the packet fence stays held through canonical handoff or
query-draft admission; only then may
selection notification refresh from canonical data. a failed literal handoff
retains the existing query draft and its canonical base.
software return may arrive as committed composition text ending in a newline.
in structurally capable prose and reference fields, the engine preserves that
literal delimiter until handoff and consumes it for the ordinary return command
only while the captured input still owns command authority. code, shift-return
and explicit-save composers retain their own newline/save rules.
consuming a reconciled semantic key grants no permission to refresh or adopt
remote state. a field without an admitted document stays
read-only until synchronous admission binds its real initializer.
the narrow observer adapter depends on the locked prosemirror-view version and must be requalified
when it changes. ordinary insertion consumes the query at acceptance. replacing
an occurrence keeps its query until the owner admits the change. ordinary
typing in other fields continues while structural commands wait for the open
query to finish.

one resource undo manager tracks distinct occurrence origins within the same
session history. origin changes break typing groups. an inverse extends coverage
only through owned receipts whose prestate permits that component's advance.
this preserves independent work from another history even on the same replica,
including a touch-only restore. an already removed predecessor does not block an
owned redo from remaining undoable. frozen field proofs additionally retain
shared-text identities and deletion sets; conservative coverage may keep a
concurrently changed source visible.
position receipts update relationship positions without replacing their observed
membership frontier. history replay synchronously installs an eventual receipt
future in the same occurrence owner before another command can observe it. that
future folds every matching link patch through its actual prestate certificate;
new membership starts with empty coverage. its safe result reaches the retained
field before the bound retires, including offscreen. bound/promise/ref/parent
identity governs relationship publication; receipt ownership governs command
settlement. same-parent scalar history keeps the current proof; reparenting uses
the target bookmark's proof. each occurrence retains its own typing origin and displayed
frontier; another session’s received state is not proof of observation.

an occurrence keeps its earliest unproved admitted source through rapid moves
and history replay. a canonical target joins only its needed source proofs in
one revision-consistent window admission; reciprocal moves can therefore settle
together. every selected request and current placement receipt is revalidated
after awaits, including dependencies already admitted. successful installation
retires only placement metadata. the same field keeps its guarded relationship,
body and baseline until canonical projection can take over synchronously.
source proof may contain independent membership; it does not require absence.
an installed ancestor can also withdraw an unfocused target from this projection.
visible parents count before their first data window exists. retiring that local
obligation keeps the field and never asserts canonical deletion; retained docs
stay charged until the existing history/admission owners actually release them.
detaching an embedded branch immediately revokes its projection and queries.
the same record retains only owner ancestry while pending placement, history,
focus or an unresolved capture needs that path. detached ancestry never loads or
renders a window; only actual unfinished writing can keep its old host visible.
registration identity fences late cleanup from a replacement attachment.
standalone embedded outlines use their containing field occurrence and target as
logical scope. the portal's separate mount key never enters history identity.

pending outline export reads one fresh retained-cell snapshot as literal text,
including visible completed segments and the active body. the workspace keeps
that same account-scoped guard above its error boundaries. “copy pending outline
text” and the runtime's “copy unsaved note edits” are separate exports that may
overlap. their text is never concatenated as if disjoint. the runtime's own
stopped-workspace guard remains necessary after its provider unmounts. shelf
passage composition retains its existing ephemeral policy; it has no outline
draft or new recovery owner.

touch-capable panes expose six fixed actions: outdent, indent, move up, move down,
undo and redo. the shared render-environment owner detects touch capability with
`any-pointer: coarse`, independently of layout. hardware keyboards use the
outline shortcuts listed in settings; platform modifiers share `usesMeta`. no insert or finish-editing control is
needed: return inserts and moving focus ends text editing.
window navigation uses the rows' quiet text controls at the outline's type size.
noneditable islands remain interactive without being treated as soft-keyboard
entry through the surrounding editor.
android reports actual keyboard visibility through its existing bridge; an inset
of zero alone does not imply dismissal. hiding the keyboard hides the touch
accessory without blurring the editor, changing its caret or revoking input.
actual focus entry, trusted editing intent inside the editor, or keyboard show
reveals the accessory again; projection and selection updates do not. selected
blocks always retain their touch commands. native keyboard hiding also restores
the mobile player without changing focus; browsers retain their focus-based
player suppression.

writing rows lead with a disclose slot and a sign. a parent shows its chevron
while shut. fine input also reveals it on row hover, focus or selection. the
coarse chevron is passive. the menu folds its branch. folds belong to the visit
and occurrence. returning restores them. a fresh visit starts closed.

a note has a dot, a page its page sign, a dated page its calendar, and an
earlier occurrence its locate sign and `see above`. highlights hang a coloured
sideline beside the excerpt. a task or live habit uses the bullet itself as a
checkbox. ordinary click or space toggles it. enter opens and shift-enter forks.
other bullet links open through `?via=` their entering relationship. a press
can lift either sign for a drag. a stationary touch hold opens the row menu.
selection paints one continuous wash from the shallowest selected depth.
`daily` marks a habit. the repeat sign and `2+` (or a larger floor) report
distinct parents in the loaded links and pending fields. the seed has a
decorative dot. each row publishes its link path as `data-note-block-id`.
top-level rows use the bare link id. return waits for initially open windows
to paint or fail. markers remain noneditable chrome
outside `contentDOM`; glyphs never enter authored bodies, history or clipboard
serialization. opening and relationship
menus retain the same native control and focus target. retaining an open empty
input does not establish child
availability. they disclose authored local links, excluding relationships
already traversed by that occurrence. a bounded batched local query proves child
availability. unfiltered outline windows prove sibling count and starting rank
after traversed-edge omission. the viewport sizes gaps from that count and
requests rich windows directly at the measured rank. explicit `outline_filter`
observes all adjacent link ids at one revision for each disclosed parent.
the outline joins them by occurrence path, omits traversed links, and keeps
matches and ancestors. the local literal fields derive from canonical
title, text and quote. explicit filtering also checks disclosed server scopes
through current admitted labels and quotes. failed scopes keep their paths and
individual retries. one `outline_windows` query reads a coherent set of bounded raw
pages, root and
boundary projections, adjacent and absolute tail relationships, and aligned child
proofs through indexed sql statements in one serialized store operation. every
slice has the same outer revision and scope availability; a failed slice fails
the whole read. sql emits ordered graph records and each
bounded resource projection once; host adapters assemble the closed response.
projection construction never feeds back into graph or cursor derivation.
each endpoint arm selects a bounded range;
it never materializes the complete incident graph. raw cursors and child proofs
precede traversal omission; neighbors surround the first and last remaining
rows, while the absolute tail excludes only the entering relationship. full
resource projections retain literal rendering, filtering and copy behavior.
android partitions outline records and their document admission snapshot into
byte-bounded native results at one store revision. a changed revision discards
the incomplete observation. an individual projection too large for one transfer
keeps its link, position and child proof and reports a failure on its row. the
root admits the remaining note/title documents together from the admission
snapshot. the existing per-ref reservation wins for live, loading and prepared
documents. absent states retain ordinary loading and latent-page preludes.
newer subscriptions merge through the existing initial-revision catch-up.
graph proofs share a store revision; unknown data
never means absent. first entry waits for
preparation; refresh retains the prior window until its replacement is ready.
a cold append keeps its existing focus intent through initial prefix admission,
proves the absolute tail and births one real empty note on demand.
journal append and title entries demand their date through the memento before
entering the editor, retaining an offscreen day after its delivery is claimed.
explicit note focus reveals its canonical occurrence through the same memento
before the existing editor selects its text.
compatible child proofs refresh independently of raw field admission. each
proof identifies its resource, relationship, parent and traversal context;
relocation discards availability but retains its revision watermark, so an
older admitted window cannot resurrect stale disclosure. only the disappearing
disclosure's actual focus moves to its existing bullet before it hides.
writing rows use that projection directly, including their native bullet links.
the opened resource retains machine-derived connections and resource management.
embedded targets render rich read-only previews; editing opens their resource.
their disclosed descendants enter the containing flat session rather than
constructing nested editors.

only a standalone page/note or journal day with an admitted complete empty child window,
no filter and no unresolved membership change has a provisional first bullet.
root title/body content does not affect eligibility. this seed has presentation
identity only: focus, blur and empty enter write nothing. `bodyHasContent` admits
first writing, including whitespace, breaks, atoms and empty code; accepting `@`
creates its direct relationship. the exact hint is `write or @ to link`, with
editor name `edit linked items`. deleting the last actual child restores the seed
after membership settles. deliberate empty notes survive. populated/nested,
embedded, loading, failed, filtered and windowed outlines reserve no input or gap.

one mounted journal shares a 64-document/16-mib history allowance across its
day sessions; a standalone root has one member. canonical encodings count once;
actual undo/redo groups, independent occurrence baselines and causal captures
count separately. an allowance-local stamp orders whole groups across days.
only accepted local editing or settlement retires the oldest eligible groups;
reads, remote updates and refused commands never consume undo. history is
visit-local and leaves with the mounted journal. presentation frontiers do not
consume history. one retiring group stays charged until its actual settlement;
the allowance recomputes usage before retiring another.

presentation has a separate soft 64-ref/16-mib target. automatic sparse branch
windows keep viewport, overscan and protected writing; distant disposable views
detach while their semantic session and bounded history survive. visible content,
native packets, composition, selection and unresolved writing are never evicted
to satisfy a heap target. a single rich body is not virtualized. pressure is
shared across journal dates. after pressure, that visit keeps reduced
prefetch to avoid alternating eviction and reload; the next visit starts afresh.
viewport leases cannot make structural commands fail merely because of scrolling. visual anchor
ids and measurements retain no writing. the seed reserves no document; first
content uses ordinary newborn admission. a failed command admission explains its
actual limit at the requested action. absolute-tail append resolves the current tail at
command preparation, rather than retaining a relationship that an earlier
accepted unlink may remove. explicit insert-after retains its chosen anchor.
if history retirement needs settlement, a new gesture requests insertion after
it finishes; a delayed split is not replayed.
no account-wide status or recovery inventory is
introduced. the runtime's unpinned document cache remains a separate owner.

## device ownership

firefox ports share the stable `/_nexus/authored/worker.js` worker named
`nexus-authored-<account>-format-5`. `IDBBatchAtomicVFS` uses strict indexeddb commit
and sqlite synchronous full. a browser web lock spans command preparation through
uncertain commit settlement; an ephemeral port lease fences a late message from a
retired or crashed owner. compatible shells reuse one account/format owner.
the version-locked vfs patch settles aborted indexeddb transactions before resetting
its queue and returns sqlite error codes from lock callbacks. a rejected callback
must never strand asyncify. the connection checks sqlite autocommit before cleanup;
if rollback also fails and leaves a transaction active, it refuses further reads
and writes rather than acknowledging provisional command state. unsaved writing
remains owned for copy and owner restart; ordinary quota failures remain retryable.

android uses bundled sqlite 2.7.1 on one serialized connection off the main thread.
that connection lazily reuses compiled statements only for validated packaged
query and search-read plans. each read drains, resets and clears bindings before
returning; any failure discards its statement and preserves the original error.
connection retirement closes all compiled statements before the connection.
dynamic reads and writes retain transient statements; no query results are cached.
the preparation mutex spans its javascript baseline read and native transaction.
fixed bridge chunks retain existing generation/account admission. both hosts keep
committed merge bytes and causal state independently of mounted editor objects.

browser offline readiness requires durable storage permission, the complete
corpus, and the explicit installed-shell asset closure. the shared vite workspace
entry serves desktop and android through host adapters. only the browser registers
the service worker; android retains packaged app-router delivery. compatible shell
activation waits for local commit settlement; format changes use coordinated
release draining rather than automatic database deletion.

firefox boundary: normal browser quit preserves a compatible waiting update
through offline restart. forced quit during that update may require one online
reopen before the cached shell loads.
the product does not add a second activation protocol to repair that platform
boundary. local corpus ownership remains independent of shell asset delivery.

both hosts transactionally upgrade a drained format-4 store to format 5: add null
work to canonical notes and every resource/passage projection; preserve replica
identity, body bytes, source sequence and cursor. a nonempty outbox refuses the
upgrade without writes. both hosts carry `E_AUTHORED_UPGRADE_PENDING` into the
existing setup refusal: drain the previous version on this device, then retry.
that surface offers no sign-out or discard action. unknown formats remain errors.
canonical migration 0339
adds note metadata, advances format-4 admissions and fences prior feed bytes at the
locked head. coordinated release requires drained, caught-up devices and stopped
old writers; pending immutable commands are never rewritten.

## replication

`POST /authored/replicas` provisions a fresh account replica. immutable contiguous
changes upload through `POST /authored/changes`; accepted prefixes are recognized
and compared before new commands merge. the account head lock commits canonical
states, projections, consecutive feed sequences and source acceptance together.
server tools use that same owner within their existing fenced transaction.

atomic changes are bounded to 2 mib fully encoded; nonstreaming envelopes and
change-feed pages to 3 mib, including base64 and wrappers. an indivisible command
occupies a page alone when needed. refuse oversized input before local success;
never commit a command that its upload envelope cannot carry, truncate writing or
rewrite committed bytes to fit. migration preflight reports existing oversize
content. local queries return bounded rows; native transfer retains 24 kib raw
chunks within 64 kib frames. the whole streamed corpus snapshot has no 3 mib cap.

`GET /authored/changes?after=…` returns a bounded ascending prefix through one
captured head. applying each command and advancing its cursor is one device
transaction. sending and receiving proceed independently.

the document schedules finite `Sync.step({refresh})` units while foregrounded.
each unit admits at most one upload batch, feed page and scope unit. registration
and initial snapshot are exclusive units. a feed round captures one head; scope
hydration retains its frontier. `more` permits an immediate external continuation;
otherwise `retry_after_ms` and the 30-second refresh cadence govern the next step.
failed lanes retain their deadlines while healthy lanes progress. no worker timer
or passive stream exists. hide stops successors, never durable commits or an
admitted acknowledgement; return and local commits wake the document scheduler.
two visible documents may share one running unit without owning each other's lifetime.
hello checks account, wire and format before storage, with an exact revision echo.
wire admission and durable format admission remain separate. current authored format is 6.

`GET /authored/snapshot` streams a repeatable-read corpus with head and lamport in
its header and completion footer, plus exact record counts. interrupted staging
never becomes ready. publication commits all records/indexes and initializes the
local clock before consuming changes after that watermark. a corpus alone does
not establish browser offline readiness: the complete installed shell and durable
browser storage permission must also be confirmed.

scoped local search reads separate derived inputs, never another authored writer.
fixed `POST /authored/scope-inputs` metadata/status/final-fence and
`POST /authored/scope-text` pages reuse foreground sync without taking the account
head lock or extending the corpus snapshot. metadata hashes authorization,
membership and publication facts. a device publishes complete inputs atomically;
raw text and unfinished normalization resume from durable staging. local writing
remains available during hydration. explicit denial immediately blacklists only
the affected scope/reading and removes its copied text. readmission waits for a
complete fenced repair, including when permission changes return the same hash.
an unchanged idle round samples the exact digest with `active_refs: []` and skips
stored-ref sweeps unless durable staging/revocation needs repair.
status and text pages read the digest and requested-ref authority in one streamed
snapshot query; authority decisions reuse its canonical materialized relations
and never enter the digest. this removes per-ref corpus queries, not the revision's
required corpus work. evidence revision
alone never replaces authorization or publication consistency. normalization
advances one 32k-codepoint chunk with retained carry; invalid final coverage fails.

authorized pieces supply only body and proved required-note slices. highlights
follow complete canonical-anchor containment within one reading; saved passages
resolve normalized quote/context within each piece, while a whole source retains
its saved literal even when unlocated. local live links supply offline membership.
peer-highlight membership is metadata only, never peer writing ownership. shared
query execution applies eligibility and clipped lexical matching before paging;
its excerpt is separate from canonical content. both sqlite hosts use the same
fts tokenizer; native compound search rechecks the store revision before returning.

launcher `search_preview` is a compound nonpaged read with at most eight rows and
null cursors. bounded literal-name reads precede ordinary lexical filling and
reuse the same scope/evidence admission. exact, prefix and substring names are
ranked before truncation; prose remains evidence. firefox serializes the whole
read and android applies its store-revision fence to the entire operation.
`SEARCH_READ_SQL` owns its finite packaged native statements. ordinary `search`
retains its cursor and full-search/picker contract.
`search_admission` reuses that compound admission for at most eight held
`{ref, field}` targets, including current query membership and scoped evidence.
it proves the held field itself: a quotation cannot admit an emptied annotation,
and a stronger quotation cannot revoke an annotation that still matches.
it returns null cursors and avoids a corpus scan; resource existence alone cannot
prove scoped admission.

`workspace_member` identifies readings admitted by canonical global search;
independent retained-source readability does not add workspace membership.
global search keeps ordinary owned rows available during hydration and validates
highlight/media-passage candidates against complete active reading inputs.
`activation_ref` carries the selected reading without changing the capture.
the closed `source_alias` query returns active part-to-publication provenance in
`canonical_source_ref`; the destination owns read permission and location bounds.
a passage keys its semantic slice while its locator names the physical
publication. highlight locators retain exact source-owner equality.

auth/format failures pause transport while local writing remains available.
permanent sync defects retain pending bytes and show one actionable error. no
activity list, writing recovery inbox, global undo inventory or age-based causal
state pruning exists. [release steps](../issues/release-local-first-writing.md)
own coordinated format changes and device draining.

child disclosure is independent of fold and composer lifetime. removing the last
projected child removes its chevron without discarding writing, reference intent,
selection or the exact insertion destination. existence reads inspect the complete
local graph with the same occurrence exclusions as rendering, never a loaded page.
server facts remain a separate read; their availability cannot replace local state.
