# reader implementation

how the reader is built: one primitive (`apps/web/src/lib/documentReader`), three
hosts (the hosted media pane, the public `/s` reader, the android shelf), the server
contracts they read and write, and how they are verified. the why lives in
[reader-design-rationale.md](reader-design-rationale.md).

## concepts and invariants

the reader is three facts and one policy.

- **publication** (`ReaderDocument`): an immutable ordered list of text units
  (web fragments, epub spine documents, transcript segments) or one pdf, under one
  view `identity` (`g<generation>`, plus an authorized capture-manifest digest when
  present; transcripts: a digest of the ordered segment ids). read once from one
  snapshot, never mixed with another read. `readingPublicationIdentity` supplies
  the canonical coordinate version: the explicit generation, a part's own body
  identity, or its transcript digest. it never substitutes a part's parent generation
  or a capture manifest. x passage coordinates name their immutable capture instead.
  title, embedded-child presentation and transcript navigation are mutable metadata.
  a same-identity reload replaces navigation/find inputs while
  retaining units, geometry, surface nodes, held origin and unsaved progress.
- **placement**: where the eye is, `{identity, point, offsetPx, zoom}`. measured,
  never stored. `offsetPx` is relative to the visible reading line: positive
  below, negative above. capture, reflow and return use it; chrome insets can
  change without burying the captured passage.
- **cursor**: where the reader intends to resume. durable, revisioned, multi-device
  (`reader_media_state`).
- **mode**: `Reading | Exploring{origin}`. while reading, reader-intent viewports
  flow into the cursor; a deliberate jump enters exploring and holds the departure.

points are `text(unit, offset)` (offsets are codepoints into the unit's
`canonical_text`, half-open) or `pdf(page, y)` with `y` 0..1 down the page.
everything else (rail, contents, evidence, marks, find, status) is a projection of
those facts or a writer of targets.

- every placement, origin, mark and find row carries the identity it was measured
  against; a mismatch is unavailable, never reinterpreted.
- only a `reader`-intent viewport writes the cursor: within 1 s of genuine input
  (trusted wheel, single-finger drag, scroll keys, scrollbar drag), not while
  positioning, mode reading, restore done. restore, jumps, reflow and find never
  save.
- the reader never writes its location into the url (inbound targets are consumed
  once with one `replace`).
- a unit whose rendered text differs from its `canonical_text` disables selection
  and paint for that unit; captures fall back to its start, never a wrong offset.
- the document dom is never rewritten for decorations: marks, find, focus dimming
  and transient inspection use css custom highlights.

## module map

```
app/(authenticated)/media/[id]   app/s              shelf/
  hosted pane                      public reader      offline reader
        \  ReaderSource · ReaderProgressPort · ReaderHost (ports.ts)  /
lib/documentReader
  DocumentReader.tsx   useDocumentReader, useReaderState, DocumentReaderView, running-head slot, status lane
  runtime.ts           load, restore precedence, viewport policy, surface registry, state
  navigator.ts         reading/exploring, first origin, rollback, scrollbar seek
  progress.ts          cursor sync: 500 ms idle / 5 s max, single flight, keepalive, handoff
  model.ts             wire→model mapping, points, targets, structure, locator mapping
  scrollport.ts        genuine-input classification and the measure loop
  text/                TextSurface · geometry (caret, capture, ranges) · paint · find
  pdf/                 PdfSurface (pdf.js PDFViewer) · geometry (quads) · pdfjs · find
  chrome/              ReaderNavigation · MapRail + PositionRibbon · Contents + SourceIssuesNotice
lib/canonicalText      domTextCursor, domTextRanges, codepoints (dom ↔ canonical offsets)
lib/find               useFind, FindBar contract, highlightPainter (shared by every pane)
```

`lib/documentReader/**` may not import `@/app/*`, `lib/api/client`, `lib/auth`,
`lib/panes` or `lib/workspace` (eslint `no-restricted-imports`): hosts adapt the
workspace to the ports, the primitive never reaches for it.

`MapRail` owns its 32px width; hosts consume its exported width. passive ticks
retain exact positions and semantic structure/evidence lanes. unrounded track
height defines full-width 24px hit regions, with the terminal remainder merged;
tracks shorter than 24px have no interactive regions. singletons use `ReaderLink`,
clusters use the existing action menu with individually named destinations.
semantic marker kind supplies names independently of paint tone. descriptions
normalize whitespace and bound evidence to 120 graphemes without changing source
content. identical displayed names remain distinct choices.

source destinations inspect and focus the reading surface; evidence retains its
host-owned connections action. menu meaning includes the canonical destination
and track height; changed meaning retires an invocation instead of retargeting
it. opening/dismissing a chooser never adopts progress. controls removed during
regrouping return focus to the surviving map without scrolling. the shelf uses
the same map and local commands without workspace navigation.

the runtime is a plain object; react reads it through `subscribe`/`getState`
(`useSyncExternalStore`). surfaces register a `SurfaceHandle` (`identity`, `capture`,
`captureSelection`, `position`, `find`, pdf `setZoom`) and report viewports and input.
only a surface owning the ready publication may consume restoration or report
its viewport. metadata labels do not own the text or pdf viewer lifecycle.
visit capture projects that owned measurement; it does not recapture transient
layout during host resize or unmount.

the media host consumes each observed generation, title/transcript metadata,
child publication and citation change once. a newer fact supersedes an in-flight
read, including a title reverting to the displayed value. only a newly observed
generation selects versioned reload; later metadata reads retain that generation
fence. failed reads use the reader's existing repair owner.

a capture host registers its reader with the same mobile chrome and viewport
owners as a media host. ready-source annotations and evidence use
`DocumentReaderView.end` inside that scrollport and its palette; they cannot shrink
the reader as competing pane children. annotation dialogs remain outside, and
annotations stay accessible when the source cannot load.

`DocumentReaderView.before` is host content preceding the publication, including
opening and failure feedback in the existing state scrollport. ready surfaces own
the same slot; it remains outside text units, find and annotations. the surviving
reader frame uses `useActionFocusRecovery` to return focus from removed controls
to the current reading area, otherwise the frame, without scrolling. deliberate
focus transfer or owner unmount releases recovery.

## server contracts

| route | contract |
| --- | --- |
| `GET /media/{id}/reader` | one snapshot: prose `ReaderTextDocumentOut`, source-backed `ReaderPartDocumentOut`, transcript `ReaderTranscriptDocumentOut`, or `ReaderPdfDocumentOut`. text shares units/embeds; transcripts require coverage and canonical `transcript_navigation`, with empty wire sections/toc. prose archives retain their shape. |
| `GET /media/{id}/file` | a fresh signed pdf url `{url, expires_at}`; called only after a fetch failed. |
| `GET/PUT /media/{id}/reader-state` | the cursor: `{state: Empty \| Positioned, revision, locator?}`; PUT `{locator, base_revision}` compares and sets; a stale base is `409 E_READER_STATE_CONFLICT` with `details.current`. |
| `GET /media/{id}/document-map` | `{media_id, identity, status, embeds, evidence, markers, diagnostics}`: `evidence={apparatus_source,roots,counts}`; each exact resource root has native/current content, nullable own-location resolution and direct-fact metadata. count keys are `highlights`, `citations`, `links`, `machine_links`, `quotes`; facets overlap. no navigation inside. |
| `GET /public/resource-share/document` | the public reader's one read (token header). |

the old incremental reads (`/fragments`, `/fragments/{id}`, `/navigation`,
`/evidence/{span}`, fragment and pdf highlight lists and creates, the highlight
reader-target route) are gone. a text highlight whose fragment cache is gone is
listed in Evidence as unavailable (`Stale`), never painted.

owned highlights and saved passages use the account's local authored store.
creation, resize, color and deletion use its durable commands and replication;
the old highlight write routes are absent. server tools use that same authored
owner. the highlight module owns the capture and merge contract.

### source-backed pieces

ordinary web articles expose one `opening` section when retained routine text
precedes their first reading section. navigation derives its continuous prefix
and rich cuts without changing source text or authored headings. heading-free
articles keep their start command. contents, section navigation and find share
the generated section; public contents follows a nonempty toc rather than format.

section label provenance distinguishes source headings/publisher navigation from
inferred/generated wording. only source-backed labels prefill a fresh manual work
title or independently ground discovery's printed-title claim. literal selected
text still grounds titles and incipits. discovery derives provenance from its
fenced navigation proof; frozen job inputs and accepted work titles stay intact.

piece commands choose a title and proved source sections. discovery supplies an
independence verdict, source-grounded title, contributors, evidence and uncertainty;
literary examples guide that judgment without becoming stored classifications.
the private title basis distinguishes printed titles from incipits and is removed
when findings are normalized. definition edits retain the existing absolute-value,
expected-version retry contract.

the source contents query returns one complete navigation/work snapshot under a
repeatable read. current work bounds determine placement; original candidate
bindings remain creation reservations and never stand in for current geometry.
source navigation and independent-work activation remain separate destinations.
the contents list uses the snapshot's section index, not another read's tree.
candidate summaries omit quotations; creator-only detail supplies review evidence
and the currently proved selector. removed works restore their existing identity.

preview supplies the exact bounded document and any creation conflict. first
candidate acceptance carries the reviewed navigation key as well as candidate
version; this fences rich cuts even when text endpoints have not changed.
already-desired same-part retries retain their original bytes and identity.
manual editing freezes its baseline version and selection until explicit conflict
review. review adopts the saved version while preserving the chosen range; a
confirmed save advances the baseline before refreshing the surrounding view.
preparation is an extraction prerequisite; retry-wait remains observed work.
its index obligation is visible independently of import-history membership.
structural readiness ends preparation feedback even if search indexing continues.
section choices describe structural eligibility; only the complete previewed
range determines a creation conflict, so existing works do not truncate larger
overlapping selections. active contents refresh on foreground through the shared
refresh owner.

`media_text_scope.py` resolves the reading identity separately from the canonical
source. a piece freezes one contiguous source range and its proved element-edge
cuts; `reader_text_slice.py` clips retained rich html and proves its text equals
the known source substring after boundary whitespace trim. uncertain ends and
unproved rich boundaries refuse separate reading. source text is never copied or
rewritten. `ReaderPartDocumentOut` carries child body identity, source provenance
and `ReaderPartUnitOut.source_start_offset`; unit ids remain canonical fragment
ids, while unit order, text, navigation and map geometry describe the slice.

`documentReader/model.ts` alone translates mounted offsets to and from canonical
source offsets. outside points are unavailable. find, selection and duration use
only mounted text. notes are limited to direct in-body references and their
required assets; private note and asset requests revalidate that scope. a piece
has no source file or offline reading-copy capability.

highlights retain canonical source identity and appear in every readable piece
containing the complete anchor; crossing anchors stay hidden there. scoped reads
bound quote context, while compact write acknowledgements return the exact
passage without incidental affixes. a bounds update carries its required
`reading_media_id` and fences that reading publication before admitting canonical
coordinates. old and new containing views invalidate when an anchor moves.

cursor, engagement and finish belong to the reading media. piece bounds correction
advances its body generation, recomputes surviving canonical cursor progression,
requires explicit recovery for excluded cursors, and clears current finish without
erasing completion history. whole-source and sibling progress remain independent.

### transcripts

`transcript_navigation.py` reads ordered fragment ids and canonical publisher chapter
facts. its digest is both navigation `key` and processing `transcript_reader_key`;
body identity remains the segment-id digest. the finite composite media observation
compares that key and coverage. one pane effect coalesces main/child publication,
metadata publication and citation/evidence changes into one reader reload;
operation phase and unchanged polls never reload prose. child discovery attaches
after reader creation and performs one baseline revalidation when needed.
readability owns mounting and progress commits. separate observation demand gates
automatic failed-read repair and foreground catch-up; hidden readers retain
content, selection and position. keyboard focus has no separate reload owner.
before disabling a focused admission button, the hosted pane holds focus on its
existing root. root blur or pane deactivation cancels the handoff. the ready reader
takes focus only while that active pane's root still holds it; background completion
is quiet. answered refusals stay distinct from an unconfirmed admission.

chapter starts target only a containing half-open cue, choosing the last containing
cue in publication order for overlap. uncovered starts retain a disabled destination.
explicit publisher ends remain explicit; a confirmed absent end derives the next
strictly later start. historical unverified null ends stay unknown. a chapter scope
requires a bounded interval and contiguous whole cues entirely inside it; straddling
or untimed holes refuse scope. current chapter requires unique whole-cue membership.
otherwise find covers the whole available transcript and partial results stay qualified.
chapter label refresh preserves captured scope; changed identity/interval/extent or
body replacement clears scoped search. whole find retains query, active result and
placement across navigation-only refresh without reveal.

hosts pass `playback: {identity, unit, warm} | null`. the generic reader imports no
player. the hosted binding sends only changed covered cues or warmth, never ticks,
and marks the timestamp with `aria-current="time"` plus an inset gutter mark.
playing/buffering uses `--reader-accent`; paused/ended withdraws to
`--reader-text-secondary`, using the existing 80ms/600ms tokens. reduced motion
removes transitions. the reader profile owns these colors independently of app
room. failed sound, gaps or another source clear the cue; progress recovery does not.
ticks never scroll, focus, change selection, write progress or reveal mobile chrome.
`show playback position` inspects once with a return spot. reader navigation and
deep links inspect only; explicit transcript timestamps adopt reading position and
request their named episode/source time. public and shelf supply null playback.

### the cursor

- one `reader_media_state` row per user/media, owned by consumption's
  `reader_cursor.py`; `revision` is authority, a null locator is an `Empty` reset
  tombstone. cursor, engagement and completion commit in one transaction; a stale
  write records none of them. android adds `expected_reader_generation` (409
  `E_READER_CONTENT_CHANGED` on mismatch); see [offline](offline.md).
- an equal locator returns the current revision. an equal save with the current
  base counts as resumed activity; a stale equal save has no effects. other stale
  bases conflict. percentage follows current position. completion at
  known progress ≥95% remains finished until unread/reset; history is separate.
- native x replacement locks publication and all saved cursors before deleting
  fragments. `reader_cursor.py` prepares exact whole-text or literal ±64-codepoint
  matches, requires one match, applies new ids/offsets/revisions and recomputes
  progression without recording activity/completion. ambiguity or absence rejects
  the whole replacement. web saves lock publication even without a supplied
  generation and check revision before admitting old targets. non-x replacement
  remains [separate work](../issues/web-publication-invalidates-saved-reader-cursors.md).
- the locator wire is unchanged (android stores locators opaquely). the web writes
  `target` and `locations.text_offset`/`total_progression` exactly and `null` for
  `progression`, `position` and the quote triple. pdf writes `page`,
  `page_progression` and `zoom` (`null` at page width, so it fits wherever it
  reopens). the terminal locator is the last unit at full length with
  `total_progression = 1`, written only after trusted forward input reaches the
  end; the server derives completion from it.

### the reader profile

one `reader_profiles` row per user (`theme`, `font_family`, `font_size_px`,
`line_height`, `column_width_ch`, `focus_mode`, `hyphenation`), last write wins.
the workspace bootstrap reads it as a required read; `ReaderProvider`
(`lib/reader/ReaderContext.tsx`) applies a change at once and sends one debounced
`PATCH /me/reader-profile` (300 ms, one in flight, latest wins, failure keeps the
change and offers retry). `READER_PROFILE_DEFAULTS` in
`services/reader_profile.py` is the one default.

after server acceptance, the provider awaits the device-settings refresh before
marking clean or sending the next edit. browser reload durability shares the
account binding owner and refresh-only recovery described in [auth](auth.md).

the provider alone decides whether a change is accepted. it publishes `editable`
(remote admission is `Ready`); controls disable from it and never read admission
themselves. a change without admission, such as a focus-mode chord, is refused:
never applied, queued or written later. each refusal withdraws the previous
notice and offers a fresh Neutral attention notice, "changing reader settings
requires a connection", so every refusal raises its own; regaining admission
withdraws it. no profile control is a silent no-op.

## flows

**open and restore.** the runtime awaits the source and cursor, mounts the surface,
then restores once. a destination-owned source arrival takes precedence over a
source-valid visit snapshot, then the durable cursor, then the start. inspection
holds the prior reading origin without advancing it. canonical hrefs and workspace
entries share one source-target resolver; media-wide pulses and competing hash
effects are absent. a cursor naming a unit
this publication lacks opens at the start with *saved place unavailable in this document*
and saves nothing until genuine input. genuine input during that source load
skips restoration; earlier reading does not cancel a later publication's restore.
late layout follows the same geometry fence as ordinary reflow; it cannot emit
reading activity or retreat host chrome as though the user had scrolled.

owned passage arrivals resolve the immutable capture locally. the mounted source
owns permission and bounds; a published source alias proves only the part's
physical provenance. current-generation hints reuse annotation placement.
unknown or changed provenance requires one normalized quote/context match in the
mounted text; ambiguity remains unavailable. pdf extraction uses that same unique
quote rule and yields coarse page inspection when geometry is absent. arrival
never rewrites the capture or changes find state. note inspection maps canonical
projection offsets and paints only while its expected text still matches.

replacement retires prior viewport intent and queued old-coordinate saves, drains
an already-dispatched save, then reads the authoritative cursor. reports during
that binding are ignored; unaccepted movement is discarded, never guessed onto
new content. an aborted binding keeps the known copy readable but read-only with
*reading position needs a document reload*. cursor-only retry, reset and undo cannot reopen
its writes; a successful source reload or remount must rebind content and cursor.
an ordinary cursor-read failure after known content arrives remains retryable.

`ProgressState.LoadFailed` names its recovery: `RetryPosition` rereads the cursor;
`ReloadDocument` reloads and rebinds the source. both keep writes fenced. the failed
state carries `retrying`; a retained document's `refreshing` also covers the source
read before cursor binding. the action and focus remain present through both reads.
the renderer never infers the recovery from a pending flag. document and pdf
load failures use the same retained-action rule; successful recovery returns focus
to the reader only if the removed feedback owned it.
an ordinary publication reread retains the readable document. its failure stays
owned and unrendered; focus or reconnect can request the failed generation again.
read repair does not remount the reader or change the cursor's existing fences.
same-identity metadata refresh also preserves navigation feedback when position
loading has failed. only explicit position recovery restarts that restoration;
a new publication still rebinds source and cursor.

**save.** a reading viewport reports `locatorAt(primary, terminal)`; the sync
saves after 500 ms idle or 5 s after the first unsaved move, one request in
flight, latest locator only, keepalive on hide. a save that fails while the page
is leaving (or a keepalive one) is not an error and is not retried: the locator
stays unsaved for the next movement or flush (the cursor is re-read next time).
a failed save gets the existing single resend before its failure is presented.
the host maps a settled refusal or uncertain outcome to its truthful line and
transport remedy. a save failure remains until a save lands, a read settles it
or the binding retires; movement alone does not clear it.

acceptance and observation are separate in `ReaderProgressPort`. a native save
may have a durable receipt while its resulting index cannot be read. the shelf
translates that into `ProgressUnobserved`; the reader does not depend on the
native bridge's error type. known acceptance never triggers another send. it
retires only the submitted locator, preserving later genuine movement, and
requires a read before further writes. the prior actual view remains available;
no optimistic `ProgressView` is invented. the shelf's load must actively obtain
an index covering the retained receipt before claiming a current position.

**other devices.** focus, visibility, `pageshow`, `online` and pane activation
revalidate. a newer revision adopts silently only when the reader was away and
nothing is unsaved; otherwise (and on a 409) *newer reading spot available* offers
*use newer spot* / *keep my reading spot*, and movement waits for the choice. a
lectern unread/reset/undo drains and gates pending saves through paired progress
fences. Unread and failed commands re-read authority; a successful reset installs
the returned empty snapshot. Authority adoption retires earlier input intent;
hydration, reflow and inspection cannot clear unread. Genuine post-command input
can save the same locator to resume it.

**jumps.** contents, section and page buttons, links, footnotes, evidence rows,
rail markers, find, home/end and scrollbar seeks call `reader.inspect({target, signal?})`:
capture the departure, flush an eligible unsaved locator, enter exploring (the
first origin is kept across later jumps), position, roll back on failure. the
status strip says *place held · section, page n or nn%*, with a direct *return*
and *read from here* in an anchored disclosure. continuing inspection needs no
command. a fresh deep link without an origin says *inspecting this passage* and
offers *reading options* with explicit adoption; it never claims a saved departure.
choosing a transcript
segment's time stamp is reading from there (`readFrom`): the cursor moves and the
player seeks and resumes. a click on the text itself only selects (words, marks).

navigation failures are in-memory occurrences `{operation, reason}`. the navigator
owns them; acknowledgement compares the exact object and changes only feedback.
new explicit navigation and publication replacement retire old feedback; ordinary
input cancels active positioning without acknowledging a settled failure. rollback
and visit snapshots contain only mode, origin and origin availability. they cannot
restore feedback or positioning. a failed rollback makes no preservation promise.

hosted contents owns its ordinary navigation request while mounted. it uses the
existing destination admission and awaits `inspect`; only `Arrived`/`Unchanged`
reveal primary content through the companion controller. another request, source,
visit or interaction owner defeats late dismissal/focus. successful inspection
paint survives contents unmount. covering contents presents only its own exact
failure occurrence; a column leaves feedback in the source. generic contents
keeps host-independent navigation and native alternate-opening intent.

the running head’s section menu remains mounted-document navigation. current location
uses `aria-current="location"`, not selection state. ordinary opening reveals it
once; explicit first/last keyboard opening wins. live location updates neither
retire the menu nor reclaim focus/scroll.

`inspect` accepts a target or an abort-aware asynchronous target resolver. admission
captures the departure before resolution; stale completion cannot position or
publish unavailability. explicit navigation and reading intent also retire pending
host arrivals, preserving the matching signal during an arrival's own delegated
inspection. automatic restore/reflow emits no reader intent. explicit transcript
point adoption needs no viewport capture.

**text surface.** every unit mounts in one scroll; off-screen units skip
rendering (`content-visibility: auto`) at an estimated height. a viewport is
measured per scroll frame from boxes, never hit-tests (a sheet or menu over the text
cannot hide the position): the unit at the reading line (`scroll-padding-top`) by
a search over unit boxes, then its first character whose line reaches below the
line by a search over character rects (a block separator belongs to the line
before it). epub internal links (`data-nexus-fragment-id`,
`data-nexus-anchor-id`, same-unit `#id`) resolve inside the owning unit (ids
repeat across spine documents). document embeds render as cards portalled into
their placeholders inside a `data-document-embed-ui` wrapper, outside the
canonical text. the public reader hydrates token-authorised images per unit as
units near the viewport. the surface retains its last measured placement before
a resize observer reports layout changes. width, typography, endpoint extent and
realised-unit changes use the internal navigator `reflow({placement, change})`
operation. the latest completed navigation or restoration target remains its geometry
anchor until genuine reading input, another navigation/seek/continue or source
replacement. without one, reflow preserves the measured passage. initial short
content does not imply following the end. reflow keeps mode/origin and saves
nothing; ordinary measurement cannot replace explicit intent.

viewport and pixel placement are published together from one surface capture.
hosted visit retention consumes that measured placement and navigation state;
explicit navigation departure still reads fresh geometry. text positioning
realizes the target before checking arrival, retaining layout/style/paint
containment across temporary visibility changes. an already-satisfied target returns
synchronously; writes within the existing 2px tolerance are skipped, so a resize
below the passage cannot begin chasing native inertia. unchanged reflow preserves
earlier genuine input while newer input or authority always wins; actual
corrections retain the progress fence.
explicit reading/navigation and source retirement also retire the surface's
queued placement through `SurfaceHandle.retireReflow`; required layout work still
runs without restoring over newer intent. an unmeasurable retained pane keeps
queued geometry until its existing resize observer reports usable bounds.
mid-positioning measurements cannot become later queued targets. completed pdf
commands retain their measured placement, so layout never replays a mutable command.

canonical cursors reuse collected spans when whole-string nfc is identical
and token boundaries still match codepoints. normalization-changing input
rebuilds provenance; split surrogate boundaries retain the existing rejection.

text/pdf action precedence is consumed event or selection, apparatus/internal
links, remaining links and controls, saved marks, then plain content. accepted
marks consume their click. a tap clearing native selection cannot also activate
the link or mark beneath it. completed selection gestures consume only their
matching pointer's click, even when a later gesture arrives before that click.

**pdf surface.** pdf.js `PDFViewer`; zoom 0.5–2 in quarter steps (a stored zoom
outside is clamped; `null` while fitted to the width, so a position reopens fitted
anywhere). fitting and explicit zoom use the internal navigator `reflow`
operation: capture the live reading line, change scale synchronously and restore
under the existing cancellable positioning fence. it preserves reading/exploring
mode and the first origin, clears earlier input intent and records no progress;
explicit zoom cancels pending/held navigation before changing scale; saved-zoom
restoration does not. cancellation retires active positioning synchronously.
transient find matches and normalized pdf destinations use measured-placement reflow.
pdf destination resolution is admitted before awaiting pdf.js and captures the
source view at activation. rendered internal links distinguish preparing, ready
and unavailable. preparing consumes activation without replay; unavailable
activation uses the navigator's common failure notice. background preparation
settles busy state and reports diagnostics without claiming a failed user action.
`pdf/destination.ts` resolves native named/explicit annotation destinations before
pdf.js discards the event. public view/scale events bind source-relative null
coordinates and zoom; resolved links expose canonical hrefs. raw `PdfView`
coordinates are pdf user space: finite, ordered rectangles, positive explicit
zoom and an existing page are required; native clipping permits destinations
outside the crop box. saved quads retain cropped top-left/y-down page units,
including pdf UserUnit. explicit destination zoom is not a manual-control zoom.
a file is a url pdf.js fetches (it sends
same-origin cookies) or the host's own byte-range reads, fed to pdf.js as a range
transport the way pdf.js reads a url: `bytes=0-` streams the whole file in and a chunk
needed before the stream reaches it is read by range (the public reader's carry no
credentials); a file that fails to open is retried once with a fresh one from the source,
and a range read that fails later ends the open with Retry (pdf.js would wait for it
forever); the hosted pane asks for the width that shows
the widest page at scale 1 (or at its zoom); positions locate pages by their boxes
(pdf.js's current page lags a scroll); marks are per-page overlay rects
(`data-reader-mark`, class `hl-<colour>`) under the text layer, hit-tested in page
space; pages keep their source colours. the page counter and announcement use
the same reading-line page as capture, including overlapping page borders. next
is disabled at the actual viewport end, even when a fully visible final page is
below that line. the pdf.js page keeps its required content-box sizing so canvas
text and text-layer highlights agree.

**selection.** the browser owns its native range; `useReaderSelection` observes
and validates it. every reader binding receives `SelectionNotice`: `Observed`
carries a fresh `SelectionEvent | null` and `inputHeld`, while `Admitted` retains
the existing trusted gesture rule. `Captured` holds one unit's canonical range or
one pdf page's quads and quote; `Rejected` retains cross-unit/cross-page reasons.
collapsed, foreign, editable and uncapturable ranges observe null. observation
alone never starts a source session, and editor selection never admits one.

observations cover range changes, source scrolling, source pointer begin/matching
end/cancel and selection-extension chords. `inputHeld` records observed source
input, never inferred native handle contact. a pointer release admits only a
changed range or a press and release within the already selected text. completed
selection gestures consume only their matching click, so preserving or clearing
a selection cannot activate an underlying link or mark. trusted native long
press admits its touch session; later handle changes remain observable. local
`onSelecting` painting describes range existence, and suspends focus dimming.

a pending source read leaves the rendered publication valid. selection, refinement,
highlight creation and librarian transfer use its exact identity and current
geometry; fetch activity alone cannot retire them. a replacement publication
invalidates old selections through the existing identity checks. reading-position
writes retain their separate source/cursor binding fence.

`Reader.captureSelection()` synchronously delegates to the mounted surface of the
current publication and this same validation/capture path. it returns null for
absent, collapsed, foreign, editable or stale ranges and retains typed rejection.
`PassageGeometry.lines` stays in source order before clipping or visual sorting;
its first and last rectangles are the actual passage endpoints, including when
offscreen. current source geometry is measured again at reveal and placement.

`useAnnotationVerbs` keeps desktop admission and anchored composition, and
forwards mobile selection notices to `useSelectionComposer`. a trusted selection
or explicit saved-highlight activation opens one nonmodal bottom band without
focusing its editor. native handle movement updates the provisional candidate
without replacing the editor or its writing. source scrolling does not dismiss it.

first field, chooser or command interaction synchronously captures the current
valid passage before focus moves. that owned capture survives its own focus
collapse; invalid, foreign or rejected ranges never reuse an unrelated last-valid
passage. leaving before acceptance revokes provisional capture authority, not
writing. the existing visit draft retains accepted capture, body/history, colour
and destination across mobile unmounts, without restoring handles or focus.
reload and process death do not retain this unsubmitted draft.

button presses preserve the owned editor and control geometry until semantic
activation. activation settles native input before save or chat transfer;
unsettled composition refuses the action and keeps the writing. saved annotations
have their own bound editor, separate from the question. return in the mobile
question/fresh-thought editor inserts a newline. [highlights](highlight.md#identity-and-writing) owns local save, colour,
annotation and loss-guard semantics; [chat](chat.md#browser) owns transfer and send.

mobile bounds changes and explicit draft refinement require `apply selection`
or cancel. apply uses the capture frozen before button focus, and only the
matching activation may execute it. invalid/collapsed ranges retain cancel,
never an earlier valid proposal. bounds keep their unit/media/version constraints
and relocation's exact-quote rule; refinement preserves the accepted rollback
passage. desktop bounds admission remains immediate.

`SelectionDock` allocates the band only while active. it reduces the reader's
scrollport height without changing its text-column width; an initial reveal may
bring an endpoint into those smaller bounds. later handle movement owns its
scroll. the action row stays above bounded, scrollable details and input; fresh
feedback reserves its slot through focus transfer so it cannot move a pressed
control. the existing viewport owns keyboard/chrome clearance, counted once.
[overlays](overlays.md#reader-action-placement) owns containment and escape;
workspace navigation remains available, and explicit close uses the work guard.

**find.** the attached surface publishes a `FindSource`; hosted media exposes
it only after restore. `useFind` receives the pane's required `ownerKey` and
returns a `FindSession`: its source-ready controller is nullable, but its sole
clear command remains available through restoration. closing during source
replacement clears retained query state before the replacement can resume it.
visibility/focus does not capture a session: the first nonempty query freezes
the current section/page; later navigation and option changes retain it. idle
scope labels describe capability; active labels name the captured scope.
requested narrowing without a valid scope fails explicitly, never broadens.
clear aborts computation and movement and removes text/results/paint, while preserving
preferences and the reader's held first departure. owner retirement resets the
session; a publication change clears a captured narrowed query, retaining the
source's explanation through replacement loading. whole-document queries and
preferences survive and prepare against the restored replacement.
computation and reveal use separate abort signals. the existing host `onIntent`
forwards newer reading/navigation intent to `FindSession.supersedeMovement`:
it aborts movement and revokes automatic reveal while results may still settle.
find's own active movement signal preserves its reveal. the reader owns return;
find owns no second return command. a new query, option change or retry starts
fresh navigation intent; explicit match steps remain available. effect cleanup aborts
its captured computation/automatic movement; retirement aborts current movement,
including explicit later steps. cancelled reveals cannot publish success,
failure or later positioning.

text searches canonical units and paints css highlights; pdf searches and paints
through pdf.js. `FindSource.reveal` returns `Shown | Cancelled | Failed`;
activation succeeds only for `Shown`. `FindSource.href(at)` projects immutable
canonical targets through the host; standalone hosts return null. named-result
activation validates the exact row and computation/source before local reveal or
workspace dispatch. find matches and contents entries fork by shift alone. a
player chapter row always seeks; its named `read from here` command opens the
transcript, and shift forks that reading destination.
`inspect({target, signal?})` links external
abort to one navigation request. pdf match page arrival, canvas/text-layer
readiness and match positioning form one request with the transient
`pdfMatch {page, index}` target. every wait checks cancellation before geometry
writes; clear/new navigation cannot finish an old reveal. cancellation preserves
completed movement; an unavailable target retains existing failure rollback.
query/section/page controls never adopt inspected positions as saved progress.

the pdf head keeps page entry, zoom out, a fixed-width zoom-state button, zoom in,
and up/down page links on one row. the bare numeric text field commits on enter,
validates the page range and drops its draft on blur or escape; its error is the
only second line. the zoom state says `fitted` or a percent; pressing it restores
fit width, and fitted is `aria-disabled`. below the head's container thresholds,
`page` and `of N` hide while the field keeps its name and total description.
`Reader.setZoom` and its surface capability accept `number | null`: numbers
use the existing bounds, null selects responsive `page-width` fitting. chosen
mode participates in equality and restore even when fixed and fitted scales
currently coincide. zoom/fit/reflow alone never writes reading progress; the
next genuine reading movement saves the chosen numeric/null mode. leaving
before that movement may restore the previously saved mode.

## feedback and capability

reader feedback shares `Ruling`, `Fact`, `Failed`, `Field` and the session's
slips. cold objects rule until ready or a settled read failure; shown content
survives a failed refresh without a new failure row. inactive panes do not
speak. public and shelf hosts supply their stage, recovery focus and geometry.

an operation-aware navigation miss raises a plain slip, independently of
progress capability. a new attempt or owner retirement retracts it. dismissal
preserves mode, held origin, inspection, viewport and cursor. durable position,
conflict and document-recovery facts retain their status-lane actions; that lane
re-anchors the reader when its height changes. public shares use the same
navigation line and never attribute a later miss to the shared highlight.

readability, document-local find and indexed search/ai availability are separate.
the reader body does not warn about indexing beside local find. the media inspector's
availability section states the indexed capability neutrally; actual search/ai
controls may present the same domain content. every media entry observes processing
events even when the source is already readable. only the server's terminal event
ends that observation, so reopening during indexing cannot freeze an old status.

## paint: css custom highlights

text decorations are `StaticRange`s registered in shared `CSS.highlights` names;
the dom is never rewritten (`text/paint.ts`).

- **segments.** per unit, a sweep over the marks' boundaries splits overlaps into
  disjoint segments; a segment paints in its topmost mark's colour
  (`hl-<colour>`) and keeps every covering id, topmost first. marks arrive
  topmost first: the newest highlight is on top.
- **static only.** every registered range is a `StaticRange`, including
  `lib/find`'s `highlightPainter` (live ranges tax every dom mutation).
- **repaint triggers, exhaustively:** the decorations change (marks, focus, hover,
  composing passage, inspection); the document (re)mounts (a new painter); a unit enters or
  leaves the window one viewport above and below the visible band
  (`IntersectionObserver`). width,
  font, line height, column, theme and rotation need nothing: static ranges follow
  the text.
- **priorities:** `hl-<colour>` −4, `hl-hover` −3, `hl-focus` −2,
  `source-inspection`/`source-inspection-coarse`/`reader-focus` −1 (colour-setting dimming above background
  tints), `nexus-find-all` 0, `nexus-find-active` 1.
- **colours are literal** (chromium and android webview ≤ 113 ignore `var()` in
  `::highlight`); dark inks under `.frame[data-theme="dark"]`. focus is an
  underline, inspection a persistent distinct mark, hover a translucent tint.
  exact and coarse inspection remain visually different. highlight pseudos carry no radius, outline, shadow or
  animation.
- **hit-testing.** a click or mouse move resolves the grapheme under the pointer:
  `caretPositionFromPoint(x, y, {shadowRoots})` else `caretRangeFromPoint`,
  confirmed against the grapheme's rects on both sides of the caret (crossing
  into the neighbouring text node at boundaries), then a scan of the caret node,
  then of the element under the point (bidi lines). the segment index answers the
  ids, topmost first: one id opens the highlight menu, several open the *Highlights
  here* chooser; hover paints `hl-hover` and sets `cursor: pointer`.
- **registry order.** the registry is kept in ascending priority (a new name
  re-sorts it with fresh `Highlight` objects): webkit 26 crashes painting a
  highlight registered after one of higher priority, and empties a `Highlight`
  that leaves the registry.
- **focus mode** (`reader-focus`): paragraph dims everything near but the block at
  the reading line; sentence dims all but the `Intl.Segmenter` sentence there.
- selection offsets come from the untouched dom (`resolveDomRangeOffsets`).

## the hosted pane (`app/(authenticated)/media/[id]`)

`location.ts` owns strict portable `ReaderDestination` parsing and fixed-order
serialization. portable text destinations use canonical source offsets; local
controls map once through `model.ts` before producing a destination, and arrivals
map once into the mounted slice. local inspection retains the local target. hosted targets use `/media/<id>?loc=<compact JSON>` within the
existing 4096-character href limit. one `loc`, exact fields, publication identity,
format, unit/anchor/item membership and valid geometry are required; competing
saved-source selectors fail visibly. invalid targets never become whole-source
navigation. cold hrefs and in-app activation use the same source-arrival owner.
an accepted-source handoff cannot also carry a located arrival; that conflict
uses the same invalid-arrival path instead of settling and discarding its target.
saved-post links use `?post_revision=<revision>` and resolve the logical post to
the reading media's current primary capture. this semantic intent survives an
accepted-source handoff, failed acquisition and retry; application waits for a
readable publication. whole-post inspection starts at offset zero, including
image-only posts, without a quotation mark. competing selectors and obsolete
`?x_post` arrivals fail explicitly.
an authored destination exceeding the href bound has no raw-hash fallback:
its focusable link control still inspects locally or reports shifted unavailability.

`ReaderHost.navigation` is a nullable href/activation capability. reader core
imports no pane/workspace state; public and shelf hosts inspect locally. the port
reports synchronous `Accepted | Refused` admission; local inspection retains its
asynchronous outcome. hosted
contents, section/page navigation, map, authored links and evidence items bind
the same capability. shift opens the exact destination without inspecting,
seeking, changing selection or advancing progress in its source. reader chapter
activation inspects; timestamp activation explicitly reads and plays. shift opens
a timed reader location without starting playback.
choosing a local section through its menu focuses the reader source after
inspection. standalone previous/next controls retain their repeatable focus.

the hosted running head is page furniture on desktop and retreating pane chrome
on the phone. `useReaderChrome` builds one `{label, content}`: desktop returns it
through `MediaPaneBody` and `HostedReaderView` as `DocumentReaderViewProps.head`;
mobile publishes it through `PaneChrome.navigation`, with reader typography on a
`display: contents` wrapper. crossing the breakpoint remounts the head and closes
its menu. unsectioned text, loading, failure and a pdf without page state publish
no head, group or reserved height. other reader hosts do not supply this slot.

`DocumentReaderView` places the head first in its frame, then the status lane and
surface. the head and lane are full-width stable-scrollbar-gutter boxes; their
inner measure shares the text column's reader face, size, width and 16px gutters.
this keeps both content edges equal with classic scrollbars as well as overlay
scrollbars. pdfs keep frame width. the lane is never a containing block: the phone
status stack still positions against the frame and inherits the inner measure’s
computed maximum width; the scrollport owner aligns its absolute bounds with
the actual scrollport client box, including a classic scrollbar's width.
its ref and `:empty` contract remain on the stack; the measure wraps the stack,
not its children.
the head uses the frame's reader-theme remap; mobile navigation uses pane paint.

`ReaderNavigation` knows no placement. text keeps one row: a contents/chapter
sign and verbatim italic title open the existing destination menu, followed by a
fixed percent folio and up/down links. title and pdf words use the reader's face
at `--text-sm`. only the title ellipsizes. below `20rem` only the folio's visible
digits hide; its spoken ordinal, total and percent remain. the folio uses the
reading-line fraction, except that the document end says `100%`.

placed sections form one stable order by start fraction. up first lands on the
enclosing section's start when it lies above the viewport, otherwise the last
strictly earlier start; without an enclosing section it is disabled. down lands
on the first strictly later start, except at the document end. duplicate starts
cannot trap either direction. disabled steps retain a placed link target and
mounted host, preserving repeated keyboard focus where the host supplies hrefs;
without placed sections they are disabled buttons. all destinations inspect,
retain the first origin and never adopt saved progress.

title and gauge keep `structure.sectionAt`'s current-section contract, including
its transcript membership and end-clamping limits. the gauge clamps the reading
line's fraction between the current start and the next strictly later start,
else the document end; an absent or unplaced current section leaves it empty.
its span is the head root's content box. the folio's terminal `100%` does not
force the section gauge full. scrolling updates folio, gauge and steps separately
without rebuilding menu rows; state selectors return primitives or stable refs.

a non-transcript title yields by opacity only when its current start is in view
and its own words open the canonical unit from that codepoint offset. matching
collapses whitespace and requires equality or a following space; it runs when
the current section changes. hover, focus or an open menu restores the title;
its accessible name always remains `<label>; select <noun>`. a missing section
uses `contents` or `chapters`. transcripts never yield. shared menu minimums yield
to the positioning owner's measured viewport cap.

`sourceArrival.ts` applies resolved server sources and direct reader/chat
locations through one saved-intent, claim, cancellation and focus fence.
`InspectSource.purpose` distinguishes fresh opening from restored visits.
`ReaderState.viewRestoration` reports the exact snapshot, publication and outcome;
readiness alone does not prove restoration. initial view snapshots are one-shot.
a valid copied view bypasses old locator resolution/validation; absent or obsolete
views use the canonical href, while failed restoration refuses visibly.

pdf find urls carry publication identity, page, frozen query/options, original
eol-free utf-16 bounds and sha-256 of that page's complete extracted text. local
indexes remain paint-only. replay uses the same pdf.js matcher and accepts only
the exact range/digest before movement; extraction changes refuse. arrival owns
paint until its actual inspection signal retires; cancellable positioning has a
separate shorter lifetime. idle find/reflow preserve paint; a new query or
semantic navigation supersedes it. fresh arrival retires prior local find.
`Reader.restorePdfFind` rebuilds applied exact paint after a remount without
repositioning the restored view. `pdfviewer` alone attaches its find controller;
a second attachment would reset early-arrival matches. pdf.js upgrades must
qualify that lifecycle, normalization, offsets and extraction together.

closed location codecs reject unknown/duplicate fields and invalid coordinates.
`loc` decoding is shared by workspace, native opening and reload. oversized cold
links show entry refusal over the resumed workspace and are never persisted.
already-applied remounts use the visit memento; full reload reapplies `loc`.
source-target reads carry the landing media id as their reading scope, or explicit
null in another kind of pane. live passage links retain that chosen publication
even when the viewer can also read the canonical source.
saved notes outside the body open their retained reference disclosure under the
child identity; their canonical locator stays unchanged and no progress is written.
arrival intents remember `Pending`, `Applied` or `Retired`, without storing
failure presentation. apply returns `Applied`, `Unavailable`, `Cancelled` or
`FailureHandled`; the last delegates feedback to the reader, preventing duplicate
notices. newer local intent retires waiting/running arrivals before old resolution
can move the source. rejected attempts release their inspection lifetime;
acknowledging failure retires replay. a retired arrival
is skipped on remount; reopening a reference creates a fresh attempt.

media preserves arrival api errors for the existing transport policy. an observed
stale build retains canonical reload-only recovery while the document remains
readable; fresh navigation cannot dismiss that fact. new-pane admission failures
have their own local occurrence. forking does not supersede source inspection.
evidence-item arrival opens connections and reveals the grouped root by canonical
ref, native id or direct edge id. it expands source text when appropriate,
waiting for the mounted disclosure shell before focus, without awaiting fetched
content. an edge enables its own facet; native ids enable their native facet.
root/marker arrival retains an already visible facet, otherwise uses marker
precedence. it scrolls only the connections port; refresh cannot replay a consumed
request or change the reading position.
it reveals a hidden branch through the outline owner without resetting folds or
mounted drafts. static item text receives programmatic focus, never a tab stop.
mobile retains that connections sheet; its own layer may receive arrival focus.

`MediaPaneBody` owns one transient evidence request. its identity, current visit
and existing arrival signal fence preparation, sidebar revelation and completion.
the pane commits view/root/type preparation before passing the request to a row.
a margin arrival whose measured passage intersects the reader bounds stays in the
margin; any other margin arrival selects all items once. without a view radio an
arrival leaves the saved preference alone. only the requested type is enabled;
unrelated filters survive. delivery, unavailability, cancellation and replacement
retire the request at its owner; map refresh and inspector remount cannot replay a
completed request. row revelation scrolls only the sidebar; arrival focus keeps
the existing permission fence.

filter identity uses the document-map count keys: `highlights`, `citations`,
`links`, `machine_links`, in that order. `evidence/model.ts` owns the typed labels
`highlights`, `citations`, `links`, `librarian links`. the first three draw
`Icon.Highlight`, `Icon.SourceReference` and `Icon.Link`; librarian links has no
sign and keeps its visible word. controls read each count directly by its key.
hidden filters, exact-fact reveals and marker classification share those keys;
presentation labels and glyphs never determine membership. signed filters are
`ChoiceField` facets named by their visually hidden labels; librarian links is an
inline checkbox named by its visible label. its count
describes the current view; an exact count, zero included, shows as an aria-hidden
numeral and is described separately (`1 item`, `{n} items`). zero never disables
a filter.

reader connections view is remembered in the pane-visit memento. filter and view
preferences survive independently of publication. active row, normal-flow anchor
and source-text disclosure belong to the body/generation/part publication key;
source-text keys also identify source media and occurrence. native scroll writes
visit data without requiring a react render. initial layout, including failed
detail reads, restores the same visible anchor until user input or an explicit
arrival wins. publication replacement retires browsing geometry; a missing
anchor starts the list naturally. writing and outline folds keep their owners.
`lib/margin/useMarginLayout` owns height/baseline measurement, two-pass admission,
nonoverlap, focus/overlay holds and sidebar-scroll folding; `stackMargin` owns its
4px gap and movement cap. source adapters supply ordered occurrence keys and first
line geometry. explicit reveal first scrolls the margin, then lifts an occurrence
above its scroll origin without moving the source or changing mode; later source
motion continues from that actual placement. reader retains evidence membership,
windowing and editor lifetime; librarian supplies chat occurrences.
runtime `subscribeGeometry` delivers paired
viewport/placement after corrections and the committing effect, before paint.
there is no global window-scroll workaround or independent consumer source clock.

a margin needs a visible text, so the view radio exists only in a column companion
over a source that is not absent. there a segmented `RadioGroup` with a hidden
legend shows `margin` and `all` on the shared content-width thumb track, named
natively `margin beside the text` and `all items`, with no routine help. mobile, the desktop sheet, unreadable media and
failed documents derive a flat normal-flow list without changing that preference
on scroll or layout changes. `Tab` is native in the margin, where off-screen
anchored rows are unreachable by it; all items walks the logical order through
`requestFocus`. local sidebar scrolling preserves its offset through unchanged
source placement, refresh and resize. entering effective alignment or changing
the source placement realigns; focused controls remain pinned. outer sidebar
scrolling is measured against its offset at the last source alignment; realignment
adopts the current outer viewport without snapping the header back. the unpinned
anchor stays inside the list when its header makes exact passage alignment
inaccessible; existing displacement feedback reports it. radio selection of all
items preserves a visible occurrence within native scroll bounds. a held row
outside the current view stays mounted, keyed and hidden with its note draft.
empty feedback distinguishes a complete empty inventory from type-filtered or
unavailable content and never claims absence while the document or a source is
loading. a margin with nothing placed says `nothing in the margin`, or
`no available connections in the margin` when incomplete, and offers
`show all connections`, which lands in all items with focus on the list. a
stretch with nothing nearby stays blank.

| file | owns |
| --- | --- |
| `MediaPaneBody.tsx` | composition: media record, shared finite processing/metadata observations, the reader, annotations, arrivals, find, evidence/contents bodies, render states, banners, end of document and the lectern prompt |
| `hostedReader.ts` | `hostedSource`, `hostedProgress`, locator/extent conversion, displayed-publication validation and visit-owned source inspection |
| `annotations.ts` | `MediaAnnotations`: local authored highlights, attached notes and links remain authoritative; separately reads the mounted media and distinct X owner maps. Each owner occurrence admits offsets only at its explicit publication generation. Canonical evidence rows dedupe by ref while mounted decorations retain their occurrences; a replaced document cancels its old read wave, including same-identity replacements. Failed reads retain only the still-mounted owners’ cached maps. |
| `useAnnotationVerbs.ts` | selection admission, canonical mark verbs, mobile bounds capture/confirmation and highlight pane entries scoped to this reader visit |
| `useSelectionComposer.ts`, `selectionDrafts.ts` | visit-retained annotation/question draft, native capture acceptance, durable local saves, explicit refinement and immutable chat handoff |
| `SelectionDock.tsx` | desktop anchored composer and mobile layout band; pre-focus capture, native-input settlement, refinement, pickers and feedback; overlap chooser and recolour dialog |
| `HighlightColourPicker.tsx` | split one-click highlight command, anchored palette and shared accessible swatches; its ephemeral presentation never owns or remounts the note draft |
| `evidence/` | explicit view radios, type filters, measured non-overlapping source alignment, sidebar scrolling/focus and shared recursive resource rows; all items uses normal flow |
| `chrome.tsx` | hosted running-head placement; pane chrome: header, find, inspector bodies, view menu (reader theme choice, reader settings link), the shared 32px document map (desktop), pdf intrinsic width, keys (`g`, `g e`, `g c`/`shift+G`, cmd/ctrl+f, shift+Esc, Esc) |
| `Transcript.tsx` | transcript admission states, expanded publisher-notes card, memoized reader playback binding and one-shot position action; header playback uses the canonical action projection |
| `activity.ts` | consumption activity from reader viewports (word ordinal when reading) |
| `Embeds.tsx` | embed cards |

source arrivals persistently inspect the complete target in the chosen pane only.
resolution, positioning and paint share cancellation and source identity; a newer
arrival or changed publication cannot apply an older result. unavailable location
is explicit. transcript inspection marks the full interval without seeking playback.
saved colours and the durable reading cursor remain unchanged. see
[resource references](resource-references.md) for the shared capability and focus
contract. a map measured against another publication is re-read before paint.

reader root membership and location are independent; see
[connections](connections.md#reader-inventory). one marker per placed root uses
highlight, source-reference, ordinal-citation, link, machine-link precedence.
acknowledged graph changes and the existing notes change topic refresh the map:
relationship-note creation/detachment changes direct membership as well as previews.
time extents intersect current transcript units; absent overlap is unavailable,
never positioned at a nearby unit. native marks paint every mounted occurrence.
composite maps merge exact refs/facts, keep canonical source media/identity and
apparatus attribution internally, and project only mapped own extents. an unmapped
canonical location is unanchorable. one shared chat/marker is retained across
constituent publications; embeds keep their separate projection.
pdf roots stay page-space quads, never reader points: the surface measures
their alignment; canonical document-map markers, normalized by page height,
give their rail position and order.

## reviewed html repair

`reader_publication.repair_reader_html` owns representation repair in one
serializable publication transaction. the operator supplies the exact media,
publication generation and every fragment's reviewed html hash. pinned pieces
and unconverted structural navigation refuse repair. unchanged html preserves
its generation. changed html must preserve full canonical text, fragment ids and
order, named anchors, apparatus and embed slots; table paths are rebuilt and the
ordinary publication generation advances atomically.
the same transaction requests ordinary index reconciliation for the new generation;
old-generation bounds and structural witnesses cannot remain current.

the owner inventories retained highlights, saved passages, retrievals, citations,
reader quotes and cursors. every previously resolving reference must still resolve
through its existing public resolver after the new generation, with the same
words, coordinates and activation. historical captured bytes and identities stay
immutable; current locations report the new publication. saved cursor coordinates
remain valid and unchanged. any failed proof rolls back the entire repair.
`python/scripts/repair_reader_html.py` is its maintenance entrypoint, with no reimport or
generation alias.

## around the reader

- **mobile chrome.** the host's `ReaderHost.scrollport` registers the surface's
  scroll element with chrome and viewport owners. chrome owns tap-driven
  visibility; viewport publishes stable endpoint extent and current occlusion.
  `scrollport.ts` reads one bounds snapshot, independent of ordinary padding.
  capture/navigation retain the shown reading line while visible ranges,
  selection and popovers use current bounds. geometry-only measurement uses
  explicit `Geometry` cause: programmatic intent, no progress/adoption/completion
  or navigation. actual layout changes use the existing reflow fence with the
  cached pre-change placement; occlusion changes never reflow. one independent
  measured status stack protects return/adopt/retry controls. scrolling and
  programmatic positioning do not change the visibility target. see [workspace.md](workspace.md#mobile-reader-chrome).
- **consumption activity.** reading time accrues only while the pane is active,
  visible and focused, after genuine input within five minutes; reading viewports
  add the document fraction and word ordinal. inspection counts time only. see
  [consumption-activity.md](consumption-activity.md).
- **quote to chat.** raw passages and saved-highlight references transfer into
  the destination's retained draft. asking creates no highlight; accepted quotes
  belong to their user message as live references and coordinates. saved annotations
  remain private live context; no source words are copied into chat storage.
  current source-access admission gates disclosure. [chat](chat.md) owns transfer, preparation,
  admission, continuation defaults and recovery.
- **offline copies.** a reading copy zips the same `GET /media/{id}/reader`
  document; the shelf maps it with `readerDocument()` and renders the same
  `DocumentReaderView` with a device progress port. see [offline](offline.md).
- **theme.** two reader themes, warm-neutral, never pure black on white; literal
  tokens on `.frame[data-theme]` in `documentReader.module.css`. pdf pages keep
  their source colours; the theme paints the frame around them.
- **view menu.** for every readable item, pdfs included, the view section opens
  with the `Reader theme` [menu choice](overlays.md#surfaces), the words "Light" or
  "Dark", which sets the profile theme absolutely; without `editable` it
  is disabled with "requires a connection". an unreadable item has no theme row.
  the "Reader settings" link to `/settings/reader` follows, carrying that route's
  sign (`ReaderSettings`), the destination's one glyph.

## verification

`./scripts/test` checks static consistency, generated contracts and shelf/
extension builds. it runs no unit or live suite. affected behavior is qualified
under [the local verification contract](../local-rules/testing-standards.md).
historical reader harnesses are retired; this module owns the contract, not
verification receipts.
