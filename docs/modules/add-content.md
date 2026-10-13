# add content

status: current contract; single-screen add/import.
scope: the browser-local add task and its existing acquisition/placement owners.
[implementation and qualification](../add-import-plan.md).

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
panel renders its commands; it never calls acquisition or allocates replay keys.
row destinations, the new-item seed and the bulk header have separate scopes.
header deltas add/remove one library on populated drafts and seed, preserving
other selections. mixed coverage is derived; sent/saved rows are excluded.
`All` membership is implicit.

`LibraryDestinationPicker` owns shared search/create, with item selection or native
all/some/none checkboxes. query changes synchronously retire continuation authority;
every settlement belongs to its query, cursor and generation. deactivation clears
loading and fences late replies. the shared chooser keeps keyboard-active options
inside its own scrollport. busy search is read-only, preserving focus.

one active picker belongs to a row or header. desktop uses the responsive anchored
surface; add on mobile uses an inline region in the scrolling body. header chooser
content sits at the body's top. escape/back closes the picker first. inline
regions omit outside-pointerdown dismissal so the intended click can complete.
retarget resets search; removal/submission/session replacement cannot revive an
old target or restore focus to its removed anchor. creation locks picker dismissal
while task close retains the stop guard. other picker consumers remain responsive.

## acceptance and leaving

submission revalidates the ready subset, captures destinations and a new key per
row synchronously, then admits two at a time within one mutation slot. invalid and
empty drafts send nothing. saved receipts remain in the task; ordinary completion
neither navigates nor closes it. acceptance proves saving; upload publication
proves verified bytes. neither proves completed extraction.

known refusals stay on their row, including revoked destination access. auth and
sent defects retain their frozen request before the existing handoff. check/retry
replays exactly that intent; edit/new attempt returns to draft and receives a new
key only on submission. stopped unsent rows return to drafts; started urls remain
unconfirmed and files retain the existing upload/imports recovery semantics.
accepted file rows release browser file handles. stop/reset/discard/unmount fence
all older callbacks. reload loses browser drafts/files.

`leaveReason` prioritizes active stop, unresolved acceptance/placement, unfinished
draft/refused work, then no warning. empty drafts, seed-only changes and settled
receipts are clean. normal and defect-boundary dismissal use the same confirmation.
explicit leave discards browser state and never promises to undo a server commit.
add has no back-to-launcher step.

## saved placement

accepted aliases share actual placement inventory by media id. reads are lazy;
submitted destinations never substitute for inventory. bulk work deduplicates
media ids, rereads eligibility and excludes unavailable targets. only admitted
direct/absent relations change. closing a picker leaves uncertain changes visible
on their receipts and in the attention count. admission/check closes saved-item
pickers; reopening performs the existing authoritative read.

one placement read/write owner per media excludes stale completion. send is
recorded synchronously; acknowledgement installs the confirmed relation before
another await. a transport failure, sent defect or stop after send retains the
exact media/destination/verb and inventory. retry sends those retained commands
without an inventory prerequisite or changed-selection inference. reads never
erase uncertainty. queued retries preserve the prior uncertain command; retry
auth restores it. refused changes settle with feedback; media-not-found is terminal
unavailable. this remains the existing placement controller, without a new cache
or consolidation layer.

## acquisition boundary

`lib/imports/ingest.ts` owns the public url/upload protocol and one
`AcceptedIngest { kind, mediaId, duplicate, processing }` result. imports copy is
owned by `lib/imports/copy.ts`; native success shapes come from generated types.
the independent extension owns its capture decoding.

an upload capability whose signing round trip exhausts its window is re-signed
once by replaying the same key. the storage put runs under the lesser of 240 s and
capability expiry. timeout, caller abort, network failure and non-2xx are reported
to the transport-failure endpoint; confirmation publishes verified bytes. storage
requests carry no nexus credentials. exceptional durable recovery remains in
imports. backend source execution/publication/replay defects retain their own
owners and tickets.

`./scripts/test` remains the permanent static gate. temporary isolated live tests
are removed after green and review; the plan links retained observations and limits.
