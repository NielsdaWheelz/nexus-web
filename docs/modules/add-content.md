# add content

status: current contract; single-screen add/import.
scope: the browser-local add task and its existing acquisition/placement owners.

## editor

one ordered list contains editable url drafts, file drafts, frozen work and saved
receipts, followed by one insertion row. typing promotes that row without changing
its identity or input element. empty url drafts retain identity and libraries but
use no capacity, ready/attention count or leave warning. twenty populated rows is
the limit, including invalid inputs and saved receipts; intake overflow is atomic.

`addInput.ts` owns raw-list parsing and draft validation. clipboard outer whitespace
is trimmed before splitting at newline, tab or comma followed by whitespace;
separator commas are consumed. ordinary single-value paste uses native selection
and caret behavior. a partly selected populated field refuses list paste.
prose/markdown stays editable invalid text. valid http/https spelling and
punctuation stay intact; ambiguous no-space commas offer an explicit split.
file validation reuses `lib/imports/ingest.ts`: nonempty pdf through 100 MiB, epub
through 50 MiB. rejected files remain rows. file selection/drop appends in order;
recognized drops prevent native navigation even while intake is unavailable.

`useAddContentSession` owns the immutable snapshot and its synchronous ref. the
panel renders its commands; it never calls acquisition or allocates request ids.
row destinations, the new-item seed and the bulk header have separate scopes.
header deltas add/remove one library on counted current populated drafts,
preserving other selections; the separate new-item control changes the seed.
mixed coverage is derived; sent/saved rows are excluded.
`All` membership is implicit.

`DestinationChooser` adapts item/bulk deltas to `LibraryChooser`, the shared action
combobox. the complete writable catalog uses the existing keyed read owner;
matching is local. every query starts inactive until arrow navigation. accepted
actions clear it and keep input focus. typing remains available during writes.
`useDestinationCreation` belongs to the form: a create freezes scope and adds only
to surviving original drafts, preserving newer selections and queries.

one active picker belongs to a row or header. desktop uses the anchored
`PickerSurface`; add on mobile uses its inline region in the scrolling body. header
chooser content sits at the body's top. escape/back closes the picker first. inline
regions omit outside-pointerdown dismissal so the intended click can complete.
retarget resets search; removal/submission/session replacement cannot revive an
old target or restore focus to its removed anchor. creation allows picker dismissal
and editing; final submission waits for it. task close retains its loss guard.

## acceptance and leaving

submission revalidates the ready subset, retains the selected libraries' reviewed
order revisions and reads one removal revision before any provider or storage i/o.
each row freezes that guard vector and its request id (a url attempt or an upload
session), then admits two at a time within one mutation slot. invalid and
empty drafts send nothing. saved receipts remain in the task; ordinary completion
neither navigates nor closes it. acceptance proves a past save; upload publication
proves verified bytes. before
showing current saving, url receipts reread media availability and placements;
upload receipts carry the current named-placement snapshot. removed/unavailable
receipts say so and offer no current-content open or filing action. neither
acceptance nor publication proves completed extraction.

known refusals stay on their row, including revoked destination access. auth and
sent defects retain their frozen request before the existing handoff. check save
replays exactly that intent. an unknown outcome cannot return to an
editable draft. a known guard refusal requires explicit review, refreshes the
selected library snapshots and returns to draft. a url then receives a fresh id;
a live upload retains its session, generation and staged bytes for confirmation
with reviewed choices. stopped unsent rows return to drafts; started requests
remain unconfirmed under the same memory owner.
accepted file rows release browser file handles. stop/reset/discard/unmount fence
all older callbacks. reload loses browser drafts/files.

the task registers actual populated rows, unresolved acceptance, destination
creation and its running browser pipeline with the common work guard. empty
drafts, destination seed changes and settled receipts are clean. normal and
defect-boundary dismissal use one native confirmation. cancellation keeps the
transfer running; confirmed leave stops remaining browser work and discards its
local state. accepted imports remain server-owned. add has no back-to-launcher
step or reload recovery.

## saved placement

accepted items are filed through the shared "Libraries…" overlay
(`components/libraries/PlacementOverlay.tsx`), which the panel hosts as its row or
header picker (inline on mobile): a receipt's libraries… opens it for that media,
the saved-items header's libraries for all… for every accepted media
(deduplicated). with several items a library is chosen when it holds all of them;
choosing files those that lack it, unchoosing unfiles them all, and a partial
library reads "In n of m"; an item deleted since it was added is left out. reads
are the shared placement controller's; submitted destinations never substitute
for inventory. accepted explicit edits are serialized per library across targets
within the
account owner. only an acknowledged local predecessor can supply a pending
command's next revision; external reads never rebase accepted intent. an unknown
write remains frozen for check change. a stale refusal refreshes inventory and
requires a fresh explicit choice. create-and-file is one atomic library create,
with all selected resource refs and the frozen removal revision.
admission/check closes saved-item pickers. the add session owns no placement state.

## acquisition boundary

`lib/imports/ingest.ts` owns the public url/upload protocol and one
`AcceptedIngest { kind, mediaId, importRef, processing }` result. imports copy is
owned by `lib/imports/copy.ts`; native success shapes come from generated types.
the extension shares only the generated wire types.

url receipts name the admitted media import; every upload receipt names its exact
session import. `uploadIngestFile` publishes the create's ref through `onImportRef`
before transfer or confirmation can fail. the add owner retains it under the
existing callback fence through phase changes, uncertain acceptance and stop.
a reviewed upload keeps that identity and staged generation; a new url intent
gets a fresh key. known identity does not prove acceptance: unresolved rows retain
check save and their original command.

every known-ref row offers `view import`. it uses the existing guarded leave and
an exact selected imports url with explicit `import-detail` activation. cancellation
preserves browser work; confirmation may stop/discard it. blocked navigation keeps
the existing retained-target flow. there is no resumable add session. a receipt records prior acceptance; a resend
is not evidence of content duplication.

an upload's live owner retains its id, generation, frozen confirmation and whether
the byte put completed. after a successful put, check save retries only that exact
confirmation. a known revision refusal permits review and confirmation with the
same generation and bytes; it neither creates another session generation nor
repeats the put. an unpublished read does not settle unknown publication. the
server decides staging expiry. file reselection replaces the expired row in
place, keeping its destinations and consuming no additional intake slot.

closing a picker retains accepted work; losing the actual task/visit owner or
reloading loses the confirmation state. recovery then uses the existing imports
file-reselection/re-upload flow and says “choose the file again to continue”.
there is no durable confirmation draft or resumable-upload promise. storage puts
carry no nexus credentials.
