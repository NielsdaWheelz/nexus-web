# reversible reader navigation: council review

date: 2026-09-26
status: research and proposed contract; no implementation approval assumed
scope: in-document inspection, return, reading-position persistence, and completion
evidence: static source inspection plus web research; no live reader or device run

subsequent owner approval is captured in the
[implementation plan](reader-reversible-navigation-plan.md), which settles this
review's proposed choices and owns execution. the research below is historical.
its maximum-progress policy was superseded by the
[current-position contract](media-row-plan.md).

three native subagents examined progress correctness, reader products, and
reading research/accessibility. the council is a synthesis of these perspectives,
not a claim that external specialists reviewed nexus.

the working checkout is `cfa27d6ce615bb4775e7784954f19dcdd8c8ebb1`, with unrelated
local changes. relevant files were compared with the locally available
`origin/main` snapshot `48722a34fdd0e5d3026dedb7014969572f327a8b`. that snapshot
already repairs superseded map jumps losing their original departure and adds
shared article/epub section controls. neither snapshot establishes the deployed
version. application code and existing local work were not changed by this review;
this document, new tickets, and register entries are the only task edits.

## recommendation and philosophy

preserve a reader's place automatically whenever navigation becomes inspection.
use a quiet, persistent reader-local control with explicit actions:

`back to your spot · chapter 3, 31%`     `continue reading here`

the visible destination, the saved reading place, and the return origin are
different facts. a popup displays their relationship; it must not own it.
scrolling through a long note is still inspection. elapsed time, selection,
inspector closure, and pane backgrounding must not silently adopt the note.

this is the digital equivalent of keeping a finger between pages. the system
should preserve the reader's main thread while allowing attention to move.
navigation serves understanding; completion bookkeeping is secondary. a visited
coordinate is evidence of location, not evidence that intervening text was read.

the main trade-off is one explicit action when a detour becomes the new reading
session. automatic adoption saves that action but cannot distinguish studying an
endnote from deciding to continue the book there. prefer explicit commitment.

## what the repository actually does

paths below are relative to the repository. line references describe the working
checkout, except where another snapshot is named.

| owner | inspected behavior | implication |
|---|---|---|
| `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:2867-2905` | map positioning captures a departure and retains one origin through completed jumps | extend this existing concept; retain the supersession repair in `48722a34f` |
| same file, `:4613-4637` | genuine input clears the origin and releases the preview fence | reading or tapping within a long note ends protection |
| same file, `:6424,6431-6433` | return is in the contents inspector; hiding the inspector clears the origin | return lifetime is incorrectly coupled to presentation for the requested behavior |
| `ReaderActivityAdapter.ts:153-165`, beside the media pane | trusted prose input invokes that adoption callback | trusted input establishes human interaction, not commitment to a new reading thread |
| `apps/web/src/lib/reader/useReaderProgress.ts:573-625` | lifecycle flush may capture even a clean viewport | checking only scroll saves is insufficient |
| `MediaPaneBody.tsx:2715-2748` | lifecycle capture rejects a non-`Reader` semantic viewport | preserve this useful persistence boundary |
| `useReaderProgress.ts:541-547` | dormant, clean panes can automatically adopt a remote cursor without checking exploration | remote revalidation and viewport adoption need separate decisions |
| `ReaderProgressHandoff.tsx` beside the media pane | existing nonmodal surface resolves cross-device position conflicts and save failures; it has no dismissal timer | reuse its visual treatment/accessibility where useful, not its conflict semantics |
| `apps/web/src/lib/panes/usePaneFind.ts`; reader find adapters | find owns another return lifecycle and preview lease | reader find and other jumps must share the same reading origin; generic query/results ownership can remain |
| `apps/web/src/offline-reading/OfflineDocumentReader.tsx:673-679,694-709,727-748` | contents has return; scrolling/map closure clears it; internal links navigate with `Restore` and no origin | shared leaves alone do not provide shared navigation policy |
| `apps/web/src/components/PdfReader.tsx:1878-1910`; `pdfReaderRuntime.ts:82-88` | native pdf links use pdf.js directly, without an app excursion callback | native link destinations must enter the shared contract before moving |
| `apps/web/src/lib/reader/readerScrollInput.ts:12-13` | home/end collapse into ordinary forward/backward reading input | preserve seek provenance; page-down and end are different operations |
| `MediaPaneBody.tsx:7392-7402` | the internal-link callback is epub-only | arbitrary article fragments need ingestion/target support, not only a return button |

the suspected disappearing popup is therefore not established as a timeout bug.
the inspected return path disappears on input or inspector closure. focus-mode
chrome has a separate timer, and target pulses have timers, but neither should
define the new return lifetime. no live reproduction identified which surface
the user had seen.

progress has several current meanings:

- canonical resume cursor: latest accepted reading position; it can move backward.
- library progress: greatest accepted `total_progression`, stored by
  `put_reader_cursor_in_txn` in `python/nexus/services/consumption/service.py`.
- finished status: derived at `0.95` or later by the one read-state rule in
  `python/nexus/services/consumption/projection.py` (`FINISHED_PROGRESSION`).
- quick-read remaining time: based on the current cursor, not the maximum;
  backward reading can increase the estimate (`docs/quick-reads.md:33-44`).

one accepted cursor write updates engagement and can create completion facts
(`put_reader_cursor_in_txn` in `python/nexus/services/consumption/service.py`). saving the old position
after a bad jump does not roll back the high-water mark or completion. prevention
must occur before admitting the destination to the writer.

the current revision-based writer and offline native pending-position store are
valuable infrastructure. retain them. an excursion does not require another
server cursor, sync service, event log, or database schema.

## precedents and what to borrow

these are documented capabilities, not a hands-on ranking of current releases.
the rationale column is our inference unless the source explicitly states it.

| precedent | documented behavior | rationale and choice |
|---|---|---|
| [readwise reader](https://docs.readwise.io/reader/docs/faqs) | separates reading progress from last location; exposes return; mobile's close control adopts the displayed position | borrow separate positions and accessible return. reject an unlabeled close action that changes progress |
| [readwise's original explanation](https://readwise.io/reader/update-oct2024) | compares protected reading position with a ribbon bookmark; detaches it during internal navigation or unusually fast movement | useful philosophy; speed-based inference remains fallible |
| [kindle page flip](https://press.aboutamazon.com/uk/2016/6/amazon-announces-page-flip-a-new-way-to-hop-skim-and-jump-through-kindle-books) | pins the reading page while exploring maps, images, highlights, and other pages | exploration should begin with confidence that the main thread survives |
| [kindle scribe notes](https://d1ergij2b6wmg5.cloudfront.net/kug/kindle_scribe/v1/en-US/html/kug_2022_26_09.html) | supported notes open in a preview with a separate go-to action | inspecting a short note need not move the primary viewport |
| [apple books notes](https://help.apple.com/itc/booksassetguide/en.lproj/itccf8ecf5c8.html), [nonlinear content](https://help.apple.com/itc/booksassetguide/en.lproj/itc6120b3793.html) | semantic epub notes and supplementary spine material can open separately from the narrative | source semantics distinguish supplementary material; do not guess from superscript appearance |
| [apple books on iphone](https://support.apple.com/en-mt/guide/iphone/iphc1af7c57/ios) | return to a previous reading location and a corresponding forward action | returning home and retracing a path are both useful, but different |
| [kobo navigation](https://api.kobobooks.com/1.0/ReleaseNotes/121) | prior-page retention and page previews during scrubbing | preserve context while seeking, before the reader becomes lost |
| [koreader](https://koreader.rocks/user_guide/) | navigation history, skim origin, read-region displays, and optional hidden reference flows | origin, path history, and coverage deserve separate concepts; do not import its whole configuration system |
| [acrobat](https://helpx.adobe.com/acrobat/desktop/get-started/learn-the-basics/navigation.html), [zotero](https://www.zotero.org/support/kb/keyboard_shortcuts) | previous/next visited views differ from adjacent pages; zotero documents link history across its reader formats | record deliberate discontinuities if history is added; do not turn every scroll into a browser-back entry |

user reports reveal failure modes, not prevalence or proven current defects:

- [readwise's 2024 discussion](https://www.reddit.com/r/readwise/comments/1gb308o/)
  describes unexpected return prompts during skimming and image skipping. staff
  acknowledged excessive sensitivity and added a hide option. this argues against
  treating velocity as an authoritative commitment classifier.
- [a 2026 readwise report](https://www.reddit.com/r/readwise/comments/1quhrmu/not_have_reading_progress_update_on_a_brief/)
  describes scanning toward the bottom and checking notes contaminating progress.
- [zotero's navigation discussion](https://forums.zotero.org/discussion/97898/solved-back-and-forward-buttons-in-built-in-pdf-reader)
  includes difficulty discovering return and confusion with an undo icon. use a
  visible text label, not a curved arrow whose meaning must be learned.

none of these sources proves all the required timeout, reload, offline, and sync
semantics. those remain nexus requirements, not borrowed assurances.

## research and accessibility

[marshall and bly's navigation study](https://www.microsoft.com/en-us/research/wp-content/uploads/2005/06/f115-marshall.pdf)
observed readers previewing ahead, revisiting earlier material, and rejoining
their main thread. its three natural magazine readers and eight digital sessions
make it exploratory evidence for the mechanism, not a universal effect estimate.
our inference: excursions are ordinary reading behavior and deserve automatic
placekeeping. a [four-month study of fourteen document readers](https://graphicsinterface.org/proceedings/gi2008/gi2008-16/)
also found varied navigation strategies; short movements do not uniquely identify
linear reading.

[daisy's reading-app requirements](https://daisy.github.io/reading-apps-ux-reqs/requirements/published/FINAL-20251031/)
explicitly call for return after internal links, footnotes, search results, and
glossary navigation, plus useful screen-reader positioning. they recommend
multiple location histories. this is expert accessibility guidance, not a claim
that a single pinned origin meets every recommended navigation capability.

[wcag timing guidance](https://www.w3.org/WAI/WCAG22/Understanding/timing-adjustable.html)
allows temporary messages when equivalent information or functionality remains
available elsewhere. a timer on the sole return action is therefore the wrong
design. use a persistent nonmodal action; announce availability politely without
moving focus into it. [status-message guidance](https://www.w3.org/WAI/WCAG21/Understanding/status-messages)
supports that distinction. reserve room so the control does not obscure text or
keyboard focus, including under zoom and the mobile keyboard
([focus not obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html)).

on an intentional jump, focus/assistive reading position should follow the
destination. return should restore meaningful position at the source occurrence,
not merely focus an arbitrary container. opening a true modal note has a separate
[dialog focus contract](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).

## the council's questions and disagreements

| perspective | question | position and objection |
|---|---|---|
| reading researcher | is this movement part of the main thread or a lookup? | preserve both possibilities; scrolling and dwell do not answer the question |
| interaction designer | does requiring adoption turn reading into mode management? | favors automatic adoption after sustained reading; accepts that it breaks long-note inspection |
| data architect | what assertion does a saved percentage make? | explicit adoption; never confuse visited location, resume, coverage, and completion |
| accessibility specialist | can return still be found after interruption or with a screen reader? | no timeout, real labeled controls, meaningful focus return, no hover dependency |
| document engineer | is the target actually retained and exactly resolvable? | canonical locators plus source version; broken source anchors cannot be repaired in a toast |
| product engineer | which owner enforces the promise for every input and lifecycle path? | one shared reader owner; rejects feature-specific booleans and parallel hosted/offline policy |

agreement: protect the origin, keep navigation reversible, distinguish presentation
from persistence, and use existing source/progress contracts.

disagreement: explicit adoption costs a click; automatic adoption is convenient but
cannot make the required guarantee. choose explicit adoption by default.

disagreement: a full back/forward trail helps scholarship, particularly nested
references. one pinned origin satisfies the requested home return with less state.
choose one origin initially; explicitly accept no per-hop history. this is narrower
than daisy's recommendation. leave workspace/browser back about document visits.

disagreement: hiding the control versus abandoning the place. if dismissal is
offered, label it as hiding the strip, retain return in reader controls, and keep
progress protected. do not let an `x` stand for adoption. this costs a compact
ongoing state indicator; otherwise hidden frozen progress becomes a different trap.

disagreement: what survives restart. recommend protection for the open document
visit; close/reload resumes the saved reading spot. resuming the detour after
restart would require persisting both the displayed destination and versioned
origin outside canonical progress. do not promise literal immortality for local
component state.

## proposed behavioral contract

1. **capture before movement.** capture the live departure, including any unsaved
   ordinary reading position. retain a canonical locator and viewport-relative
   geometry. an already queued pre-departure save may finish; it must never be
   replaced with the inspection destination. show return only after a real move.
2. **one origin for the visit's excursion.** `a -> note b -> reference c` returns
   to `a`. find, contents, highlights, source links, chunk/fragment links, and pdf
   native destinations participate in the same origin. selecting an already
   visible passage without moving does not create an excursion.
3. **retain protection while inspecting.** scrolling, selecting, waiting,
   backgrounding, and closing find/inspector do not adopt. known seeks such as
   home/end or a scrubber are inspection; sequential page turns and ordinary
   traversal in the main reading thread remain reading. do not use pixel speed
   or dwell thresholds to revoke an explicit excursion.
4. **return is positioning, not progress.** restore the exact passage and relative
   placement; with unchanged layout, repeated round trips must not drift. after
   reflow, preserve the semantic passage and useful viewport alignment. restore
   focus at the referring occurrence when applicable. clear origin only on
   successful return; failures retain a retriable return action.
   an authored backlink that resolves to the recorded referring occurrence uses
   this same return action; a backlink to another occurrence remains inspection.
5. **adoption is named.** continue reading here captures the settled destination,
   deliberately changes the resume place, and resumes ordinary capture. while
   positioning or if exact capture fails, retain the origin. successful local
   adoption enters the existing ordered writer and its save-failure/conflict
   treatment. never interpret the travel distance as
   text read. under the existing position-based percentage, deliberate adoption
   can advance the high-water mark substantially and, at 95% or later, can mark
   the document finished. this is an explicit exception to automatic gradual
   movement, not coverage accounting. preserving that completion behavior is a
   consequential pending product choice, not an incidental implementation detail.
6. **dismissal controls presentation.** no timeout. if a hide action exists,
   leave a compact, accessible route to return/adopt. do not discard origin,
   re-show the large strip repeatedly, or change saved progress on dismissal.
7. **preserve progress across lifecycle paths.** while inspection remains active,
   its destinations cannot enter cursor saves, lifecycle flush, native pending
   progress, maximum progress, completion, or remaining-time projections solely
   because positioning occurred. explicit adoption is the separate transition
   above. returning does not reverse unrelated legitimate pre-departure writes.
8. **remote state stays separate.** revalidate normally, but do not automatically
   reposition an exploring pane. retain a newer remote candidate. accepting it is
   an explicit transition through the same owner; it must settle the local
   excursion deliberately and preserve existing revision conflict handling.
9. **entry and exit are explicit.** a deep link opening a document with saved
   progress can use that saved place as the return origin; do not capture the
   temporary top-of-page paint. a targeted first open without saved progress is
   inspection with no return origin: offer continue reading here, omit back to
   your spot, and require adoption before persisting the target. the explicit
   trade-off is an extra action on a first targeted visit in exchange for not
   letting an opened citation mark an unread document as read. an ordinary
   untargeted first open begins normal reading. reopening normally resumes the
   saved reading place. changed/unavailable content exposes
   an unavailable return state instead of guessing by percentage.
10. **short notes can avoid travel.** the separate source-note/margin work can
    provide contextual inspection, with full navigation available. this return
    feature must independently work for long notes, arbitrary references, and
    incomplete note extraction; new popup-note rendering is outside this slice.

the open product fork is the meaning of percentage. if the user wants percentage
of text actually covered, the current maximum-position model is insufficient.
that requires range accounting, rereading/skip semantics, and compatible offline
storage. do not quietly add it to this change or pretend interpolation makes a
position metric into coverage. questions about explicit adoption and percentage
meaning were presented during the review; the defaults here are recommendations,
not recorded user answers.

## ownership and implementation scope

consolidate the existing map/find excursion machinery into one shared reader
navigation owner under `apps/web/src/lib/reader`, composed by hosted and offline
reader sessions. it owns origin, current positioning request, return/adopt, and
progress eligibility. source adapters own target resolution and exact movement;
the existing progress owner owns serialized writes, conflicts, and sync. chrome
only presents state. this matches the cross-format ownership principle in
[readium's navigator guidance](https://readium.org/kotlin-toolkit/3.2.0/guides/navigator/navigator/);
its save-every-location example is not the desired persistence policy here.

reuse `ReaderSemanticViewport`, canonical text/pdf locators, `paneScroll.ts`, the
existing request-supersession machinery, and `ReaderProgressPort`. keep generic
pane find query/results logic; remove its competing reader-origin ownership.
adapt native pdf destinations without patching vendored pdf.js. preserve source
revision and offline publication checks.

the existing progress handoff panel provides useful styling, polite announcement,
and focus machinery. a local excursion and a remote cursor conflict must remain
separate states with unambiguous actions. choose one stable reader status area;
coexisting statuses must not stack overlays over prose. the return action cannot
be inside chrome that disappears while an excursion is active, and need not pin
every toolbar merely to stay available.

activity has an additional coupling: `ReaderActivityAdapter.ts:121-144` suppresses
activity while the preview lease is active. extending that lease indefinitely
would undercount time spent reading notes. cursor adoption and engaged time are
different facts. recommend counting genuine note-reading time with the existing
recorder, using duration-only observations during settled exploration. do not
provide progress or word-position endpoints for those intervals. the deliberate
trade-off is no forward-word or reading-speed measurement for exploration; time
still counts. offline currently has no activity adapter, so this adds no offline
analytics promise.

close the current observer's activity span synchronously before moving, using
its old measurement, and clear its input timestamp. genuine input after arrival
can open a new interval without adopting the location. close the exploration
interval before adoption restores ordinary measurements. ordering matters:
`activityRecorder.ts:257-258` replaces an observation before reconciling, and
`:363,380-384` reads that measurement while closing. a destination measurement
published after a jump could falsely join distant word positions. the existing
recorder already supports ineligible transitions and absent endpoints
(`:100-106,122-137,291-350`); no new telemetry subsystem is justified.

natural wheel/touch reading remains an approximation of intent. explicit seeks
can be classified exactly; an arbitrary fast finger gesture cannot be proven to
be either reading or skimming. the first implementation should make that limit
honest, not add an uncalibrated reading-speed classifier. automatic recovery from
all accidental scrolling is broader than safe, explicitly initiated excursions.

## existing dependencies and implementation findings

return drift and find lease retirement were resolved by the navigation-owner
change. [lost authored article anchors](tickets/web-ingest-replaces-authored-heading-anchors.md)
and [cursor invalidation on source replacement](tickets/web-publication-invalidates-saved-reader-cursors.md)
remain separate. article anchor repair is
required before claiming arbitrary article fragment parity; correction of new
ingestion and repair of stored imports need separate evidence. source publication
repair retains its existing owner; excursion restoration must expose its failures.

the implementation also resolved the five research findings: inspection input
or closure ending an excursion, offline links without a return origin, remote
handoff replacing exploration, native pdf links bypassing navigation, and
home/end seeks being treated as reading.

## proportionate verification

implementation should pass `./scripts/test`, the sole automated static gate.
this review did not run it: no application code changed. no current runtime
acceptance is claimed from historical reader receipts.

use a small set of real journeys, with state inspected before and after:

1. article/epub/pdf: at a mid-document spot, jump forward to a note near the end,
   scroll/select there, jump backward and into another fragment, wait, close the
   inspector, then return. verify immutable origin, no timeout, useful focus,
   no round-trip drift, and no false completion.
2. overlap two asynchronous jumps; fail a target; interrupt return; change layout.
   only the current successful request may settle state. failure preserves a
   recoverable origin, and source-version mismatch never fabricates a target.
3. background/foreground and reload during exploration; deliver a newer remote
   cursor; explicitly adopt or return. verify the chosen reopening policy and
   that remote progress cannot silently seize the viewport.
4. repeat internal links and return on the actual android offline artifact, then
   reconnect. inspect native pending progress and the eventual canonical cursor.
5. keyboard and screen-reader activation, narrow/mobile layout, large zoom, and
   on-screen keyboard. verify target reading position, return discoverability,
   focus visibility, and ordinary sequential reading including chapter boundaries.

settle or identify legitimate pre-departure writes before comparing cursor
revision/locator, maximum progress, completion facts, remaining-time projection,
and activity boundaries. unchanged revision alone is too strong when an earlier
valid write was already in flight; no inspected destination admitted as reading
is the actual invariant. add an automated owner-level regression only if its
race or persistence failure justifies maintenance under the local testing rules.
