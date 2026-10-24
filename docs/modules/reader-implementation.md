# reader implementation

how the reader is built: one primitive (`apps/web/src/lib/documentReader`), three
hosts (the hosted media pane, the public `/s` reader, the android shelf), the server
contracts they read and write, and how they are verified. the why lives in
[reader-design-rationale.md](reader-design-rationale.md).

## concepts and invariants

the reader is three facts and one policy.

- **publication** (`ReaderDocument`): an immutable ordered list of text units
  (web fragments, epub spine documents, transcript segments) or one pdf, under one
  `identity` (`g<generation>`; transcripts: a digest of the ordered segment ids).
  read once from one snapshot, never mixed with another read. identity versions
  source text; title, embedded-child presentation and transcript navigation are
  mutable metadata. a same-identity reload replaces navigation/find inputs while
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
  DocumentReader.tsx   useDocumentReader, useReaderState, DocumentReaderView, status strip
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

the runtime is a plain object; react reads it through `subscribe`/`getState`
(`useSyncExternalStore`). surfaces register a `SurfaceHandle` (`identity`, `capture`,
`position`, `find`, pdf `setZoom`) and report viewports and input.
only a surface owning the ready publication may consume restoration or report
its viewport. metadata labels do not own the text or pdf viewer lifecycle.
visit capture projects that owned measurement; it does not recapture transient
layout during host resize or unmount.

`DocumentReaderView.before` is host content preceding the publication, including
opening and failure feedback in the existing state scrollport. ready surfaces own
the same slot; it remains outside text units, find and annotations. the surviving
reader frame uses `useActionFocusRecovery` to return focus from removed controls
to the current reading area, otherwise the frame, without scrolling. deliberate
focus transfer or owner unmount releases recovery.

## server contracts

| route | contract |
| --- | --- |
| `GET /media/{id}/reader` | one snapshot: prose `ReaderTextDocumentOut`, transcript `ReaderTranscriptDocumentOut`, or `ReaderPdfDocumentOut`. text shares units/embeds; transcripts require coverage and canonical `transcript_navigation`, with empty wire sections/toc. prose archives retain their shape. |
| `GET /media/{id}/file` | a fresh signed pdf url `{url, expires_at}`; called only after a fetch failed. |
| `GET/PUT /media/{id}/reader-state` | the cursor: `{state: Empty \| Positioned, revision, locator?}`; PUT `{locator, base_revision}` compares and sets; a stale base is `409 E_READER_STATE_CONFLICT` with `details.current`. |
| `GET /media/{id}/document-map` | `{media_id, identity, status, embeds, evidence, markers, diagnostics}`: `evidence={apparatus_source,roots,counts}`; each exact resource root has native/current content, nullable own-location resolution and direct-fact metadata. count keys are `highlights`, `citations`, `links`, `machine_links`; facets overlap. no navigation inside. |
| `POST /media/{id}/highlights` | `{anchor: {kind: text, unit_id, start_offset, end_offset} \| {kind: pdf, page_number, quads, exact}, color}` → `201 Data[TypedHighlightOut]`. the unit must belong to the media. |
| `GET/PATCH/DELETE /highlights/{id}` | read, recolour or rebound (`anchor: fragment_offsets`), delete. |
| `GET /public/resource-share/document` | the public reader's one read (token header). |

the old incremental reads (`/fragments`, `/fragments/{id}`, `/navigation`,
`/evidence/{span}`, fragment and pdf highlight lists and creates, the highlight
reader-target route) are gone. a text highlight whose fragment cache is gone is
listed in Evidence as unavailable (`Stale`), never painted.

### transcripts

`transcript_navigation.py` reads ordered fragment ids and canonical publisher chapter
facts. its digest is both navigation `key` and processing `transcript_reader_key`;
body identity remains the segment-id digest. state/publication/chapter transactions
notify `media_events` after commit. the pane reloads on a changed key or coverage;
there is no episode-pane provisioning poll or raw media-response spread.
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

hosts pass `playback: {identity, unit} | null`. the generic reader imports no player.
the hosted binding observes the engine clock, sends only changed covered cues and
marks the existing timestamp with `aria-current="time"` plus an inset gutter mark.
pause/buffering retains confirmed time; errors, gaps or another source clear it.
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
- base-revision validation precedes equal-locator handling. An accepted equal
  save keeps its revision but counts as resumed activity; stale equal saves
  conflict without effects. Percentage follows current position. Completion at
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
an ordinary publication reread retains the readable document and projects its
`refreshFailure` beside it. retry retains that failure until a successful read;
it does not remount the reader or change the cursor's existing fences.
same-identity metadata refresh also preserves navigation feedback when position
loading has failed. only explicit position recovery restarts that restoration;
a new publication still rebinds source and cursor.

**save.** a reading viewport reports `locatorAt(primary, terminal)`; the sync
saves after 500 ms idle or 5 s after the first unsaved move, one request in
flight, latest locator only, keepalive on hide. a save that fails while the page
is leaving (or a keepalive one) is not an error and is not retried: the locator
stays unsaved for the next movement or flush (the cursor is re-read next time).
any other failed save shows *progress not synced · retry*.

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

**selection.** completed trusted source gestures publish a `SelectionEvent` with
publication identity and input origin. `Captured` carries one unit's canonical
range or one pdf page's quads plus `exact`; `Rejected` identifies a cross-unit
or cross-page selection. the host explains rejection without writing or clipping,
retires the old foreground composer and retains its draft. collapsed, outside
and uncapturable selections remain silent. editor selection and unowned
`selectionchange` never admit a source command. a pointer release admits a range
only when that gesture changed it or pressed and released within the already
selected text. an unchanged native range elsewhere does not reopen its composer
or suppress the click; native clearing keeps its usual meaning. trusted native
long press also admits its touch session. an admitted native touch session
continues through handle changes; repeated rejection is deduplicated until a
fresh gesture or valid capture. focus dimming is suspended during live selection.

the composer keeps its rich textbox below an icon command row. explicit names
appear on hover and keyboard focus, including unavailable reasons. the split
highlighter applies yellow in one activation on a fresh passage; a saved mark
shows its persisted colour with the primary inactive. its disclosure opens a
local anchored palette without reflowing or remounting the editor. palette
selection applies only to that passage; the next fresh passage starts yellow.
the picker reuses the overlay owner's dismissal, return focus and tab
continuation. a passive tooltip press preserves existing composer ownership;
actual focus moves and outside presses keep their usual ownership rules.

bounds editing retains the original unit, publication and observed highlight
version in one reader-local session. it focuses the source and shows an owned
instruction/cancel notice while selecting. another unit is rejected before a
request. the media host publishes bounds and selection-rejection feedback in
the reader chrome's existing navigation slot, where the pane measures its
height and reserves source clearance. an active visible mobile pane holds that
chrome open while the notice exists; cancel uses the shared large button and
inherits the chrome's coarse-pointer target size. the notice neither scrolls
away nor floats over selectable source content.
a valid range synchronously enters submitting, freezes unit/offsets and
version, and joins the tab's existing write fifo. submitting has no cancel
claim; source retirement hides its presentation without cancelling a sent write.
only its own still-active session handles completion. unit/version conflicts
refresh and require reopening; duplicate ranges return to selection. the
annotation acknowledgement map publishes quote/colour/ownership/version with
paint until a read begun after acknowledgement replaces them, so older map data
cannot replace an acknowledged command's observed state.

**find.** the attached surface publishes a `FindSource`; hosted media exposes
it only after restore. `useFind` receives the pane's required `ownerKey`.
visibility/focus does not capture a session: the first nonempty query freezes
the current section/page; later navigation and option changes retain it. idle
scope labels describe capability; active labels name the captured scope.
requested narrowing without a valid scope fails explicitly, never broadens.
clear aborts computation and movement and removes text/results/paint, while preserving
preferences and the reader's held first departure. owner retirement resets the
session; a publication change clears a captured narrowed query, retaining the
source's explanation through replacement loading. whole-document queries and
preferences survive and prepare against the restored replacement.
computation and reveal use separate abort signals. return cancels movement and
revokes pending automatic reveal while results may still settle; a new query,
option change or retry starts fresh navigation intent. effect cleanup aborts
its captured computation/automatic movement; retirement aborts current movement,
including explicit later steps. cancelled reveals cannot publish success,
failure or returnability.

text searches canonical units and paints css highlights; pdf searches and paints
through pdf.js. `FindSource.reveal` returns `Shown | Cancelled | Failed`;
activation succeeds only for `Shown`. `inspect({target, signal?})` links external
abort to one navigation request. pdf match page arrival, canvas/text-layer
readiness and match positioning form one request with the transient
`pdfMatch {page, index}` target. every wait checks cancellation before geometry
writes; clear/new navigation cannot finish an old reveal. cancellation preserves
completed movement; an unavailable target retains existing failure rollback.
query/section/page controls never adopt inspected positions as saved progress.

pdf navigation exposes direct minus, scale/fit-width reset and plus controls.
`Reader.setZoom` and its surface capability accept `number | null`: numbers
use the existing bounds, null selects responsive `page-width` fitting. chosen
mode participates in equality and restore even when fixed and fitted scales
currently coincide. zoom/fit/reflow alone never writes reading progress; the
next genuine reading movement saves the chosen numeric/null mode. leaving
before that movement may restore the previously saved mode.

## feedback and capability

reader feedback uses the provider-free shared `FeedbackStatus`, `FeedbackNotice`,
`FeedbackState` and `FieldFeedback` primitives. reader wrappers map their existing
ink, accent and surface tokens locally; portaled details use the application theme.
the hosted pane supplies announcement permission; inactive panes are silent. public
and shelf hosts supply their own recovery focus targets and geometry provider.

one operation-aware navigation notice lives in the measured feedback stack,
independently of progress capability. it is a warning with one factual title and
an explicit close control; it has no timer or retained retry command. dismissal
preserves mode, held origin, inspection, viewport and cursor. progress, conflict
and document recovery keep their independent actions. public shares use this same
notice and never attribute a later navigation failure to the shared highlight.

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
- **shadow roots.** a surface inside a shadow root (the dossier) needs the rules in
  its adopted sheet; `components/dossier/dossierSheet.ts` carries the find rules.
- **focus mode** (`reader-focus`): paragraph dims everything near but the block at
  the reading line; sentence dims all but the `Intl.Segmenter` sentence there.
- selection offsets come from the untouched dom (`resolveDomRangeOffsets`).

## the hosted pane (`app/(authenticated)/media/[id]`)

`location.ts` owns strict portable `ReaderDestination` parsing and fixed-order
serialization. hosted targets use `/media/<id>?loc=<compact JSON>` within the
existing 4096-character href limit. one `loc`, exact fields, publication identity,
format, unit/anchor/item membership and valid geometry are required; competing
saved-source selectors fail visibly. invalid targets never become whole-source
navigation. cold hrefs and in-app activation use the same source-arrival owner.
an accepted-source handoff cannot also carry a located arrival; that conflict
uses the same invalid-arrival path instead of settling and discarding its target.
saved-thread links prepare their exact post unit from the saved publication
before exposing a native href; obsolete `?x_post` arrivals fail explicitly.
an authored destination exceeding the href bound has no raw-hash fallback:
its focusable link control still inspects locally or reports shifted unavailability.

`ReaderHost.navigation` is a nullable href/activation capability. reader core
imports no pane/workspace state; public and shelf hosts inspect locally. hosted
contents, section/page navigation, map, authored links and evidence items bind
the same capability. shift opens the exact destination without inspecting,
seeking, changing selection or advancing progress in its source. reader chapter
activation inspects; timestamp activation explicitly reads and plays. shift opens
a timed reader location without starting playback.
choosing a local section through its menu focuses the reader source after
inspection. standalone previous/next controls retain their repeatable focus.

hosted text-section navigation keeps one horizontal row. its authored title is
visually ellipsized; the trigger name and open menu retain the complete label.
below 18 times the control font size, the visible counter keeps only the current
ordinal; screen-reader text retains the complete position. compact coarse-pointer
arrows keep 44px targets while text may increase row height. pdf controls keep
their separate wrapping layout. shared menu minimums yield to the positioning
owner's measured viewport cap.

`sourceArrival.ts` applies a union of resolved server source and direct reader
destination through one saved-intent, claim, cancellation and focus fence.
already-applied remounts use the visit memento; full reload reapplies `loc`.
arrival intents remember `Pending`, `Applied` or `Retired`, without storing
failure presentation. apply returns `Applied`, `Unavailable`, `Cancelled` or
`FailureHandled`; the last delegates feedback to the reader, preventing duplicate
notices. newer local intent retires waiting/running arrivals before old resolution
can move the source. acknowledging an arrival's exact failure retires replay
without aborting its signal or removing mounted inspection. a retired arrival
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
the pane commits all-items/root/type preparation before passing the request to
a row. only the requested type is enabled; unrelated filters survive. delivery,
unavailability, cancellation and replacement retire the request at its owner;
map refresh and inspector remount cannot replay a completed request. row revelation
scrolls only the sidebar; arrival focus keeps the existing permission fence.

filter identity uses the document-map count keys: `highlights`, `citations`,
`links`, `machine_links`, in that order. `evidence/model.ts` owns the typed labels
`highlights`, `citations`, `links`, `librarian links`; controls read each count
directly by its key. hidden filters, exact-fact reveals and marker classification
share those keys; presentation labels never determine membership.

connections view is remembered in the pane-visit memento. native radios expose
following and all items on desktop; mobile derives a normal-flow list without
changing that preference on scroll or layout changes. exact item navigation
selects all items once on either layout. local sidebar scrolling preserves its
offset through unchanged source placement, refresh and resize. entering effective
alignment or changing the source placement realigns; focused controls remain
pinned, including normal-flow document items whose preceding alignment changes
height. outer sidebar scrolling is measured against its offset at the last
source alignment; realignment adopts the current outer viewport without snapping
the header back. the unpinned anchor stays inside the list when its header makes
exact passage alignment inaccessible; existing displacement feedback reports it.
radio selection of all items preserves a visible occurrence within native
scroll bounds. both layouts retain the same keyed rows and their note drafts.
empty feedback distinguishes a complete empty inventory from type-filtered or
unavailable content; zero aligned placements alone is not an empty inventory.

| file | owns |
| --- | --- |
| `MediaPaneBody.tsx` | composition: media record (+ processing stream, metadata re-read), the reader, annotations, arrivals, find, evidence/contents bodies, render states, banners, end of document and the lectern prompt |
| `hostedReader.ts` | `hostedSource`, `hostedProgress`, locator/extent conversion, displayed-publication validation and visit-owned source inspection |
| `annotations.ts` | `AnnotationStore`: one document-map read → marks of every visible highlight (topmost first), note refs, rail markers, evidence; writes paint at once from their acknowledgement through a pending ledger that a map read issued after the write settles; a failed read keeps the last map painted; `twin` finds the viewer's own highlight of an exact extent (a library-mate's never blocks theirs) |
| `useAnnotationVerbs.ts` | admitted selection/rejection, canonical mark verbs, cancellable bounds sessions and highlight pane entries scoped to this reader visit |
| `SelectionDock.tsx` | one passage composer with an icon command row, focused rich editor, canonical resource actions and retained note conflict/retry controls; overlap chooser, recolour dialog and chat chooser |
| `HighlightColourPicker.tsx` | split one-click highlight command, anchored palette and shared accessible swatches; its ephemeral presentation never owns or remounts the note draft |
| `evidence/` | explicit view radios, type filters, measured non-overlapping source alignment, sidebar scrolling/focus and shared recursive resource rows; unanchored items use normal flow |
| `chrome.tsx` | pane chrome: header, shared reader navigation, find, inspector bodies, view menu (activity, reader settings, theme), the 52 px document-map rail (desktop), pdf intrinsic width, keys (`g`, `g e`, `g c`/`shift+G`, cmd/ctrl+shift+F, shift+Esc, Esc) |
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
- **quote to chat.** a quote is a durable highlight first; the chat send captures an
  immutable per-message `{key, evidence}` snapshot. the admission key is
  `{media_id, highlight_id, revision}`; the captured words, attribution and
  complete target never change with later highlight edits.
- **offline copies.** a reading copy zips the same `GET /media/{id}/reader`
  document; the shelf maps it with `readerDocument()` and renders the same
  `DocumentReaderView` with a device progress port. see [offline](offline.md).
- **theme.** two reader themes, warm-neutral, never pure black on white; literal
  tokens on `.frame[data-theme]` in `documentReader.module.css`. pdf pages keep
  their source colours.

## verification

`./scripts/test` checks static consistency, generated contracts and shelf/
extension builds. it runs no unit or live suite. affected behavior is qualified
under [the local verification contract](../local-rules/testing-standards.md).
historical reader harnesses are retired; this module owns the contract, not
verification receipts.
