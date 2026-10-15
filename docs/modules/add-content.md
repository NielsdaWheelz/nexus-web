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

`DestinationChooser` (`components/libraries`) owns shared search/create, with item
selection or, given the libraries only some drafts are in, native all/some/none
checkboxes whose toggle adds or removes one library. a new query aborts the read in
flight and a page belongs to the query it answered, so load more never continues
another query; closing unmounts the chooser and ends its read. `LibraryChooser`
keeps keyboard-active options inside its own scrollport. busy search is read-only,
preserving focus.

one active picker belongs to a row or header. desktop uses the anchored
`ChooserSurface`; add on mobile uses its inline region in the scrolling body. header
chooser content sits at the body's top. escape/back closes the picker first. inline
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

`leaveReason` prioritizes active stop, unresolved acceptance, unfinished
draft/refused work, then no warning. empty drafts, seed-only changes and settled
receipts are clean. normal and defect-boundary dismissal use the same confirmation.
explicit leave discards browser state and never promises to undo a server commit.
add has no back-to-launcher step.

## saved placement

accepted items are filed through the shared "Libraries…" overlay
(`components/libraries/PlacementOverlay.tsx`), which the panel hosts as its row or
header picker (inline on mobile): a receipt's libraries… opens it for that media,
the saved-items header's libraries for all… for every accepted media
(deduplicated). with several items a library is chosen when it holds all of them;
choosing files those that lack it, unchoosing unfiles them all, and a partial
library reads "In n of m"; an item deleted since it was added is left out. reads
are the overlay's own; submitted destinations never substitute for inventory.
every placement write is idempotent (keyed by library and item), so the overlay's
Retry resends a write a transport failure left unknown; refusals show their copy
and every committed filing rereads it. admission/check closes saved-item pickers.
the session owns no placement state.

## acquisition boundary

`lib/imports/ingest.ts` owns the public url/upload protocol and one
`AcceptedIngest { kind, mediaId, importRef, processing }` result. imports copy is
owned by `lib/imports/copy.ts`; native success shapes come from generated types.
the independent extension owns its capture decoding.

url receipts name the admitted media import; every upload receipt names its exact
session import, including attention and replay. `uploadIngestFile` publishes each
successful create's ref through `onImportRef` before transfer or confirmation can
fail. the add owner retains it under the existing callback fence through phase
changes, uncertain acceptance and stop. restaging clears the old key/ref. known
identity does not prove acceptance: unresolved rows retain check-status/retry.

every known-ref row offers `view import`. it uses the existing guarded leave and
an exact selected imports url with explicit `import-detail` activation. cancellation
preserves browser work; confirmation may stop/discard it. blocked navigation keeps
the existing retained-target flow. there is no resumable add session. receipts say
`saved`; request replay is not evidence of content duplication.

an upload capability whose signing round trip exhausts its window is re-signed
once by replaying the same key. the storage put runs under the lesser of 240 s and
capability expiry. timeout, caller abort, network failure and non-2xx are reported
to the transport-failure endpoint; confirmation publishes verified bytes. storage
requests carry no nexus credentials. exceptional durable recovery remains in
imports. backend source execution/publication/replay defects retain their own
owners and tickets.

`./scripts/test` remains the permanent static gate. temporary isolated live tests
are removed after green and review; the plan links retained observations and limits.
