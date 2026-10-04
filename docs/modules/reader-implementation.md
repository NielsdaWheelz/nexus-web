# reader implementation status

this records the current reader model and the constraints we actively ship.

Reader hash targets are one-shot focus state consumed by `useReaderTarget`.
Cross-section and cross-fragment reader-location writes replace the active
pane href through one seam in `MediaPaneBody`; they address the current media
visit and do not create Back/Forward history. See
[workspace.md](workspace.md) for the generic push/replace/Back/Forward
contract.

## constraints we enforce

- line length target: 50-75 chars on desktop, 60ch on mobile
- base font around 16px, with larger user-adjustable options
- line height around 1.4-1.6
- theme support: light and dark, warm-neutral palette aligned with the
  app shell; never pure black on pure white
- text alignment: left-aligned only; no justify toggle
- paragraph spacing: block style only; vertical gap equals one
  line-height; no first-line indent
- hyphenation: viewport-conditional and user-overridable via
  `reader_profile.hyphenation`
- focus mode: four states (`off`, `distraction_free`, `paragraph`,
  `sentence`) driven by `reader_profile.focus_mode`; toggle at
  Cmd/Ctrl+Shift+F; auto-suspends during active selection
- mobile-safe reader layout and controls; mobile Media panes render the shared
  Resource Inspector as a mobile sheet instead of the desktop attached pane
- one shared inspector disclosure after More in the resource header:
  `Inspector` with its label on desktop, icon-only on mobile
- on mobile, the Resource Inspector sheet is the single secondary detail path;
  the interactive Document Map overview rail remains desktop-only, while
  readable Web, EPUB, and PDF render one passive position ribbon
- resume that survives reflow where possible

## architecture

### shared document session and sources

The shared document-reader composition is the one format coordinator for PDF,
EPUB, and web articles. Within it, `DocumentReaderSession` owns source/progress
orchestration, initial active-unit and preferred-locator selection, and the
canonical locator projection helpers. Format composition and
`useReaderProgress` retain visible navigation/scroll/Find state and cursor
ordering, suppression, revalidation, and writes. `ReaderDocumentSource`
supplies resolved format inputs and `ReaderProgressPort` supplies
load/save/conflict transport. Neither interface grants generic network or
storage access.

the composed load owns its initial content. hosted composition projects that
content directly and does not start another epub fragment request while using
the initial fragment. explicit fragment reads and pdf access refreshes always
call the source; the session keeps no second consumable copy of initial content.

Hosted media composition installs the current BFF/API source and canonical
online cursor port. The Android shelf installs a source over a downloaded
copy's `reader.json` and a device progress port. `TextDocumentReader` and `PdfReader`
render resolved inputs and do not fetch media, signed URLs, highlights, or
progress. Hosted decorations remain a layer over canonical content; offline
copies contain undecorated canonical inputs.

`MediaPaneBody` remains the cohesive hosted composition owner. one
publication-bound evidence index serves lookup, marker and stance projections
without merging target, occurrence or source-reference identities. text geometry
reuses admitted navigation structure while transcript and retained rendered
bytes keep their own authority. shared text-point, source-anchor and canonical
restore operations lower movement through the existing format/navigation
primitives; pdf patches and hosted mutation leases retain distinct completion
rules. partial pdf page highlights are not an authoritative document map.

The parameterized Chromium component proof covers hosted PDF, EPUB, and article
load/restore/save through this session. It is format-coordinator evidence, not
evidence for native persistence, package integrity, or signed APK wiring.

### native read boundary

`GET /media/{id}/document-map`, `/fragments` and `/navigation` return their
owned `Data` models. generated web types feed pane loading and
`HostedReaderSource`. `documentMap.ts` decorates action subjects and uses the
shared snake-case activation wire directly;
its facts, markers, source content and associations remain server-owned.
intrinsic target/ref and marker relations belong to the small output models;
publication and section owners establish native navigation relations. embed
rendering accepts the generated model directly, preserving canonical source,
widget fields and actions; internal embeds now include previously discarded
server fields. quote grammar validation returns the original dictionary, keeping
extension values, genuine omissions and insertion order. selected output configs
make always-sent defaults required without changing constructor behavior.

qualification: 19 actual response-field models (14 frozen authenticated reads,
5 labeled graph/locator controls) preserve 64,921 literal bytes; seven isolated
relations now reject at their output owners. 20 imported presentation records
preserve retained values, widget html/canonical text, markers, anchored rows,
associations and structure; three exported command request identities match.
40 real scoped api cases preserve 14 literal successes and 26 status/error
outcomes (request ids only normalized). the actual desktop article retains its
resolved caption/card/actions, two saved highlights, map hover, selection and
find; epub section selection reaches both real fragments and retains its source
issue notice. no page errors occurred. concise receipts are
`/tmp/nexus-reader-native-candidate-{model,presentation,api,browser}-receipt.json`.
sole `./scripts/test` passed on the frozen source. pending/source-content, associations and
pdf geometry are imported/model controls; no pdf ui, offline/native/mobile,
new highlight admission, external action navigation or provider lifecycle is
claimed.

### mobile scroll-linked chrome

One active mobile reader scrollport registers directly with the workspace
`MobileChromeProvider`.

- `TextDocumentReader` registers its document viewport for Web and EPUB.
- Readable transcripts register the same outer document viewport that contains
  playback, description, and unbounded segments.
- `PdfReader` registers its viewer.
- Desktop transcript keeps its bounded segment-list scroller.
- The provider alone owns collapse progress, direction reversal, settlement,
  visible locks, live-focus reconciliation, blank-canvas reveal, and
  reduced-motion pinning.
- The app bar, optional active format toolbar, and inner Nexus control are
  presentation consumers; they never infer scroll policy.
- `MediaPaneBody` owns one stable reader interaction root for focus handoff
  across loading, error, short-content, and mounted-scrollport states.
- `paneScroll.ts` is the sole app-owned reader-positioning boundary. Find,
  restore, zoom, and anchor movement hold its lock through rebaseline.

The provider coalesces scrollport/direct-content resize, descendant load, window
resize, and visual-viewport resize into a geometry refresh. It updates the live
scroll baseline without resetting synchronized chrome presentation, except that
a reader now at top or too short to scroll reveals fully.

Chrome motion is transform-only and never changes reader padding, selection,
resume state, scroll position, or the stable outer Nexus bottom-surface
measurement. Non-reader and window scroll are outside this contract. See
[workspace.md](workspace.md#mobile-reader-chrome) for the workspace composition
contract.

### reversible inspection

`useReaderNavigation` owns one mounted-reader origin across contents, source
links, highlights, find, native pdf destinations, home/end and scrollbar seeks.
format adapters own exact cancellable positioning; `paneScroll.ts` owns
app-controlled scroll movement. inspection fences progress and completion;
hosted activity can count genuine reading duration without progress or word
endpoints. close, input and waiting never adopt a detour. the reserved reader
status offers return, explicit adoption, remote cursor arbitration and recovery.

`useFind` (`lib/find/useFind.ts`) owns query, results and staleness for every
pane; a reader supplies a `FindSource` (`media/[id]/mediaFind.ts` for article,
epub and transcript, `components/pdfFind.ts` for pdf). find's reveal delegates
reader movement to `useReaderNavigation`; conversation find keeps its own
return. article, epub and transcript match canonical text with the shared
matcher (`lib/find/find.ts`); pdf keeps pdf.js matching, normalization and
marks. the initial match is the first at or after the reading position frozen
when find opens. closing find removes marks while the reader origin remains
held.

rich transcript chapters have one readonly, required-nullable `TranscriptChapter`
shape in `lib/media/transcriptView.ts`. media-detail ingress strictly decodes
records, trims titles, drops blank titles, and stably orders by start then chapter
index once. contents, playback, and find consume that same list. interval
resolution stays in `transcriptChapters.ts`: a later distinct start caps an end,
absent or invalid ends fall back to the next start, a missing final end stays open,
ends are exclusive, and tied overlapping intervals have no active chapter. the
lectern's separate `ChapterOut` protocol remains independent.

### find marks and repaint

paint is declarative: `useFind` hands the source its rows and active index after
every change and on every `presentation` change. article and epub paint resolve
matches in the rendered fragment through `resolveDomTextRanges` against the
cursor `MediaPaneBody` publishes (`findRenderedRef`) in its canonical-cursor
layout effect; `useFind` is called after that effect, so a fragment that renders
after a reveal is painted in the same commit, and a match outside the rendered
fragment is not painted. transcript paint maps codepoint offsets onto each
segment's single `canonical_text` text node. `highlightPainter` publishes the
document-global CSS custom highlights `nexus-find-all` / `nexus-find-active`
(active over passive priority), one share per painter; `app/globals.css` styles
them with only `::highlight()`-supported properties, a double underline marks
the active match without color, and forced colors keeps both perceivable. find
never converts into a persisted Highlight.

### natural document completion

Web articles and the final EPUB section render a semantic end marker inside the
same `.documentViewport` that owns reading scroll. `TextDocumentReader`
registers that element independently with mobile chrome while its existing
progress, activity, and trusted-intent listener continues owning reader
publication. Find and reflow fences never swallow chrome sampling.

Natural completion requires trusted forward scroll intent after the current
content generation was positioned. Programmatic restore, hash navigation,
remote handoff, reflow, and section loading never complete a document. A short
document completes only after a forward wheel/touch/key intent while its end is
already visible.

The terminal capture is the existing `web` or `epub` locator at the canonical
text length. Only the last canonical fragment may set both `progression` and
`total_progression` to exact `1`. The browser owns no Finished
threshold and sends no completion command: the ordinary reader-state PUT
atomically advances Consumption engagement and completion. After the write is
acknowledged, the Lectern provider performs one FIFO-owned revalidation. Its
canonical Finished projection may publish the existing next-item prompt in the
in-flow endcap; navigation remains an explicit user action.

### Resource Inspector and Document Map surfaces

The Media pane publishes one `resource-inspector` secondary group:
**Contents** when available, **Evidence**, and **Dossier**. The
shared inspector action opens and closes that whole group: open restores the remembered tab
while it is published, else the publication's default. The reader's internal **Document Map** remains the
owner of Contents, Evidence, and the desktop overview rail; it is
not the generic secondary-pane disclosure contract.

- Desktop has a fixed **Document Map overview rail**. It consumes aggregate
  markers from `GET /media/{id}/document-map`, shows whole-document positions
  for positioned reader facts, and activates the matching contextual target.
  source ticks keep exact coordinates; separate hit groups open their members.
- contents uses the shared `ReaderDocumentMapDetail`: outline, pinned local
  scope and current position. the shared status owns return.
- evidence uses `EvidencePaneSurface` for aligned highlights, source-authored
  apparatus and resource-graph connections. follow aligns visible referents;
  browse retains the complete filtered inventory and active edit state.
- Mobile has no interactive Document Map overview rail. The same
  Contents and Evidence bodies render in the Resource Inspector's
  workspace mobile sheet; readable web, epub, and pdf render a passive, aria-hidden
  reader-relative position ribbon whose only input is the semantic visible
  range. placement is defined by the
  [mobile ribbon cutover](../cutovers/mobile-reader-position-ribbon-hard-cutover.md).
- `useResourceInspector` owns inspector visibility and remembered-tab
  selection. the reader publishes no opener of its own: the rail and ribbon
  carry no inspector control, and bare `g` dispatches the header action.
- bare `g` fires after the 500ms chord delay, or at once when a non-chord key
  follows, and invokes the published inspector action without a trigger, so it
  agrees with the header in every state. `g e` selects Evidence;
  `g c` and shift-`g` open chat. editable targets, modifier keys, and a topmost modal
  other than the inspector suppress the chord. the chord reads the action when
  it fires, so action or publication identity changes do not cancel it.
- The open region id is scoped by primary pane and secondary group. Mobile
  carries the inspector opener as ephemeral return-focus state, focuses the
  active surface tab, and returns to that opener when the sheet closes.
- Chat opens in the conversation pane; it is not a Document Map surface.

### Media Dossier and Abstract

The Dossier tab uses the universal Dossier surface. Above its revisioned content
it renders one compact, read-only **Abstract** from the current Media
Intelligence projection: Building, Ready, Stale or Failed (a dead build reads
Failed), absent when there is none; the Abstract has no Generate control or
history. The Media Dossier offers that same unit's claims, so the screen and
generation engine never interpret the same Media content version
independently; a Generate while the unit is still building waits for it.

Text and PDF selections expose one **Learn** action. The reader first
creates/reuses the durable Highlight, lets selection chrome dismiss normally,
and starts the Learn command from pane-owned state. Existing global feedback
survives the popover; success adopts the standalone Artifact pane. There is no
inline primer, tooltip, modal, or remote-page iframe.

### media identity and credits

Media publishes a typed resource header through `usePanePrimaryChrome`. The pane
label is the title and the publication carries the compact structured credits;
each line truncates independently inside the 60px resource bar. Desktop pane
chrome is one 60px header track (`--pane-chrome-header-height`) for every route
kind, and the mobile bar is 60px plus safe area.
`PaneHeaderIdentity` owns the route `h1`; each reader context explicitly offsets
imported HTML headings beneath its local outline and saturates at `h6` while
preserving anchor IDs. Main document/transcript content uses offset 1; podcast
show notes, nested below the local section heading, use offset 2.

The compact credit line selects author-role credits only, then renders the
ordered first two on desktop and the first one on mobile. Resolved visible
credits are native pane links; unresolved credits are text; noninteractive
`+N` counts the unmounted tail. Each visible name owns its ellipsis.
`metadata…` in More opens the shared self-loading overlay with publication,
source, reading/listening, activity, and availability facts.
Authorization-gated `Add author…` / `Edit authors…` opens
`MediaAuthorsEditor` separately. Both overlays return focus to the exact More
trigger, with pane chrome as the disconnected-trigger fallback.

The canonical contract for explicit `Passages | Whole document` scope,
semantic filters, and typed related-object disclosures is
[`reader-evidence-scope-associations-hard-cutover.md`](../cutovers/reader-evidence-scope-associations-hard-cutover.md).
Evidence exposes only that target-centered payload; no removed
reader lens, route, or storage-shaped response remains.

### fresh-selection icon toolbar

`SelectionPopover` mounts one `SelectionActionDock` inside
`FloatingActionSurface`. Full-capability selections expose one content-sized,
non-wrapping row of icon-only controls named **Highlight**, **Note**, **Link**,
**Ask**, and **More**; **More** exists only while overflow is non-empty and
opens the shared `ActionMenu` on the text-labeled **Learn**,
**Ask in existing chat…**, and **Share**. The row carries no visible action
text: each control's accessible name is also its native `title`.
`buildSelectionActions` owns only transient, pre-resource selection controls and
`projectSelectionActionPlan` the sole order owner, so an ineligible action is
absent and never promotes an overflow action into the direct row. Density
belongs to the pointer — 32px targets, 16px glyphs, 4px gaps, and 44px targets
under `@media (pointer: coarse)` — never to viewport width or action count. The
dock owns toolbar focus, the overflow trigger, and color disclosure only; color
is a parameter of **Highlight**, shown as an ink bar under its `Highlighter`
glyph rather than as a sibling verb. Readers remain the sole
selection-normalization and Highlight-creation owners. Once created, every
Highlight surface mounts `ResourceActionMenu`; canonical snapshots and the
shared planner own membership, labels, order, state, and dispatch.

`useRetainedReaderSelection` is the single lifecycle owner for a fresh reader
selection's captured snapshot, delayed mobile publication, visible retirement,
and geometry-refresh fencing. `useRetainedReaderSelectionGeometry` owns the
shared resize, scroll, visual-viewport, and animation-frame refresh schedule.
The Web/EPUB reader still owns fragment and canonical-offset normalization;
`PdfReader` still owns strict current-reader, single-page range admission and
page-space quad projection. Both readers provide their format-specific semantic
equality and geometry projector to the shared lifecycle. Actions read only the
retained capture, so a mutable or foreign native `Selection` cannot replace the
quote or geometry that the user actually invoked.

### quick-note composer

the **quick-note composer** (`HighlightQuickNoteComposer`) is the in-context
annotation surface: one owner component hosting the unchanged
`HighlightNoteEditor` (ProseMirror session, drafts, debounced autosave) in two
skins.

- desktop renders a `FloatingActionSurface` anchored at the selection-rect
  snapshot (not a highlight DOM lookup), dismissing on scroll; mobile renders
  a `MobileSheet` with a one-line clamped quote header and the editor as
  `initialFocus`, on the standard sheet mount contract (always mounted,
  driven by `active`).
- three entries: the selection popover's **Note** verb (creates the highlight
  concurrently and opens the composer in the same gesture), the
  existing-highlight click popover's **Add note**/**Edit note** action, and
  the bare-`n` chord while a reader selection is active. `SelectionPopover`
  is the single highlight-first composite-action sequencer for Highlight,
  Share, Learn, and chat; Note and Link retain the distinct reader-owned flows
  above.
- pending-create sessions hand the editor a stable opaque session id as its
  `highlightId` and bridge to the real highlight id inside the composer's
  save wrapper once the concurrent create resolves; the editor is never
  re-keyed mid-session.
- Esc, click-outside, scroll, and sheet dismissal flush pending edits and
  save — there is no discard path. an empty composer creates no note; the
  highlight survives in every branch.
- all note writes flow through the canonical `saveHighlightNote` path used by
  Evidence, so composer-written notes appear there with no extra
  wiring.

the `n` chord is reader-local: `useReaderKeyChord` fires on bare `n`
(no modifiers), guarded by `isEditableTarget`, dispatched where the selection
state lives (`MediaPaneBody` and `PdfReader`). it is deliberately not a
keybindings-registry entry — that registry is app-global and cannot capture
bare keys.

### contents surface

The document table of contents (epub + web article) is the Resource Inspector
**Contents** tab (`ReaderContentsNav`) and remains a Document Map feature.

- it is on-demand through the shared inspector action. When contents exist,
  Media's capability default order selects it first.
- it is available independent of highlights: it shows whenever the document
  has TOC nodes, including focus mode where highlights are hidden.
- selecting a reachable entry runs exact-point navigation, which
  replaces the pane's active href and adds no Back/Forward entry (see pane
  history).
- publisher and source-only note targets remain reachable in the full contents
  without acquiring a reading-section identity. unresolved labels are inert.
- mobile reaches Contents through the same Resource Inspector sheet.
- it has no internal scroll container: the secondary body is the single scroll
  owner. the reader prose keeps a single scroll owner (`.documentViewport`);
  the TOC is not rendered inline.

Hosted EPUB and web articles with at least one ready navigation section publish
the same pane-bar instrument. One shared projection groups coincident section
starts and selects the deepest division; its sequence drives the picker, count,
previous and next. Active state uses the original section extents, so a gap is
unselected. Before the first heading, the picker has no selection or count. Zero
sections publish no instrument while reachable contents remain available. User jumps use Document Map
positioning and its return origin without renewing reading activity; PDF page
controls remain separate.

### workspace pane sizing

The authenticated workspace owns one reader text floor for every non-PDF
desktop pane. It measures the active reader font family, font size, line
height, `column_width_ch`, and reader inline padding with one hidden browser
probe before mounting workspace state. New non-PDF panes default to that floor,
and no non-PDF pane can shrink below it.

PDF panes are the only primary-width exception. `PdfReader` measures rendered
PDF page geometry and publishes the widest rendered page as intrinsic primary
width; the workspace raises the PDF pane floor to that width. A Media route's
runtime width is unresolved until its media kind is loaded and, for PDF, that
measurement exists. During that gap the workspace may render at its text floor
but must not persist a width correction; persistence starts only after an
explicit workspace or intrinsic runtime-layout publication.

The Document Map overview rail is fixed primary-adjacent chrome: it changes
rendered pane width without changing stored primary pane width and contains no
generic open control. Contents and Evidence are Document Map
bodies inside the shared Resource Inspector; Dossier is the third Media tab. The single
`resource-inspector` width policy is independent from the primary reader width.
mobile panes ignore desktop runtime pane sizing and render at
viewport width. Mobile workspace mode also suppresses fixed primary chrome,
desktop-attached secondary columns, and pane resize handles; the Resource
Inspector reaches mobile through the workspace secondary sheet.

### document position presentation

The aggregate publishes markers from exact owner start locators. The active
reader publishes one `ReaderSemanticViewport`; `readerDocumentPosition.ts`
projects its visible start/end to `0..1` without DOM, React, persistence, or
activation policy. Marker owners already publish normalized exact positions.
The projected range feeds the interactive desktop overview rail and the passive
mobile Web/EPUB/PDF ribbon. The ribbon paints at the reader surface bottom
(`bottom: 0`); it consumes no bottom clearance, never rises above Nexus,
Player, or Android navigation, may be covered by a higher-priority surface, and
is not workspace fixed chrome. terminal reader content clears the protected
bottom band through the element-local `--mobile-content-bottom-clearance`
pane-body publication. The
[mobile ribbon cutover](../cutovers/mobile-reader-position-ribbon-hard-cutover.md)
owns its semantic range contract and proof; the
[bottom geometry cutover](../cutovers/mobile-reader-bottom-geometry-hard-cutover.md)
owns its placement.

- text is `(fragment_id, canonical codepoint offset)` over ordered unique
  fragments; every fragment contributes its length once
- semantic sections carry an exact target and optional cross-fragment extent.
  source containers determine ownership; publisher toc nesting is presentation.
  parent and child spans overlap without adding content length twice
- PDF is `(one-based page, normalized full-page fraction)`; page gaps, zoom,
  and scrollable-remainder fractions are not document coordinates
- a marker with no exact owner start has no rail marker; no midpoint, ordinal,
  section-top, or scrollbar fallback exists
- the rail receives source structure, markers, a current point, a visible range,
  pinned scope, and activation;
  it owns no scroll listener, content observer, `documentSpan`, content ref, or
  position calculation. A track-only `ResizeObserver` recomputes presentation
  groups after fixed-chrome reflow and reads no document geometry
- one aggregate projection supplies the whole-document and scoped rails. a
  highlight destination strictly joins its resolved passage highlight and all
  note associations; named destinations retain their marker label and preview.
  callers cannot supply a parallel marker-only representation
- separate structure/evidence lanes retain every exact tick at x=12px and
  x=40px. fine input groups points whose span is `<16px`; any coarse input uses
  `<48px`. grouping compares every member to the first point, so neighboring
  distances cannot chain across the document
- one pure layout owns stable group identity and disjoint hit intervals. each
  singleton target centers on its exact tick. crowded groups expose a bracket,
  count and complete native-button chooser; every painted center belongs to
  exactly one target in its lane
- the shared presenter distinguishes highlight quote from annotation, states
  missing previews, suppresses exact title/excerpt duplication, and discloses
  bounded summaries. hover and focus previews never fetch or mutate reader
  state
- each rail owns one identity-based preview/chooser state. an in-place manual
  popover supplies top-layer painting without escaping its modal ancestry.
  popup eligibility requires its containing modal to be the current top modal;
  escape, outside interaction, source replacement, regrouping and anchor loss
  close it under the rail's focus-return contract

### highlight read paths

there are two highlight read scopes by design, with different consumers and
update cadences.

- per-fragment: `GET /api/fragments/{id}/highlights` (per-page for pdf), fed
  to inline highlight rendering of the active fragment and visible highlight
  projection; re-fetched on every fragment switch
- media-wide: `GET /api/media/{id}/document-map` returns highlight items,
  markers, counts, linked note/chat summaries, and the highlight payloads needed
  for cross-fragment activation and quote-to-chat lookup; refreshed after
  highlight mutations

### reader-to-chat quote selection

quote-to-chat is highlight-first. A durable Highlight must exist first; fresh
selection actions are **Ask** and **Ask in existing chat…**, while existing
Highlight surfaces retain **Ask in new chat** and **Ask in existing chat…**.
Both launch chat with a typed intent and perform no conversation mutation on launch. The launch
address is the pane-local intent hash `#mediaId=<uuid>&highlightId=<uuid>` (the
destination is the path); the chat pane parses it, hydrates one canonical preview
through `GET /api/chat-reader-selections/highlights/{id}?media_id=`, and shows
the pending quote card above the composer.

- the request sends only `reader_selection = { key: {media_id, highlight_id},
revision }`; on send the server row-locks the Highlight and captures an
  immutable per-message snapshot (`exact`, `prefix`, `suffix`, source label,
  `locator`) that drives `<reader_selection>` for every current and historical
  turn. Client quote text is rejected, and a later Highlight edit/delete cannot
  change a sent quote
- the snapshot is not a durable conversation context ref that gets cited and
  never receives a citation ordinal; citation chips point at the attached
  `highlight:` reference or later `nexus.resource.read` evidence
- reaching a new or existing chat uses workspace canonical-pane adoption: the
  destination pane is reused or opened without duplication, and source
  activation returns to the reader pane from the immutable locator
- a geometry-only PDF Highlight (blank `exact`) is non-sendable as a quote

### anchored evidence projection

`locator_from_resolution` publishes a positional locator only for resolved
evidence and reuses the existing highlight text quote. unresolved evidence has
no locator; a readable media target remains available. geometry-less pdf
citations retain evidence-hash/page navigation without geometry paint, while
connections retain Unanchorable presentation and disabled positional Jump.
strict geometry validation and writer-produced string quotes remain unchanged;
legacy quote contexts follow the highlight's `str(value or "")` normalization.

Anchored projection is the reader-owned bridge from target-owned locators to
visible rows in Evidence. The overview rail owns no DOM geometry:
marker positions come from aggregate document fractions and its visible band
comes from the format-owned semantic viewport.

- Reflowable readers project highlights from rendered DOM segments tagged with
  `data-active-highlight-ids`.
- PDF readers project highlights from visible page geometry and the current PDF
  viewport transform.
- A committed PDF create or bounds edit enters a state-backed unreconciled-write
  ledger. The visible page is the merge of its server snapshot and that ledger,
  so page/render transitions cannot erase a successful write before read-back;
  exact server geometry acknowledgement retires the entry, while a newer
  external mutation refresh can supersede it.
- Projection remeasures after reader typography, active fragment/section,
  rendered HTML, PDF zoom/page render epoch, active secondary surface, secondary
  width, or evidence data changes.
- Missing targets are explicit projection state; they are not silently treated
  as visible rows.
- Projection state is never persisted. It is derived from current rendered
  reader geometry.

### source-authored apparatus

Reader apparatus is the reader-owned surface for source-authored footnotes,
endnotes, sidenotes, bibliography entries, and in-document citation markers. It
is not generated chat citation evidence and must not write or read
`message_retrievals`.

- Backend extraction is owned by `html_apparatus.py` and the relevant ingest
  path before semantic source attributes are sanitized away; `reader_apparatus.py`
  owns the persisted rows.
- Source-authored standalone margin notes are valid target-only apparatus rows:
  they appear in Evidence and can jump to the note target, but
  they do not get invented marker edges or hover previews.
- Evidence exposes apparatus through its `Citations` filter and
  distinguishes source references from generated citations in the typed item contract.
- Web/EPUB rows may support hover previews and marker/target activation when
  exact locators exist.
- Current PDF support is scoped to native internal `cite.*` link graphs.
  Generic PDF superscripts, reference sections, and plain extracted text do not
  create apparatus rows.

### reader connections

Reader connections are graph-authored linked items for the current media,
separate from source-authored apparatus.

- Backend ownership remains `resource_edges`; the media reader consumes those
  rows only through `GET /media/{id}/document-map`.
- Evidence classifies these rows under semantic `Links` and
  `Synapses` filters; it exposes no storage-shaped `Connections` category.
- Rows align to the referenced passage when the media-owned endpoint resolves
  to PDF geometry or exact rendered fragment text offsets. Unavailable passage
  facts remain in `Passages` under `Needs attention`; they never invent locator
  data or fall into `Whole document` merely because resolution failed.
- Activating a row opens the source object; activating its target uses the
  target-owned reader locator. Edges never store reader locators.
- **Link** (see
  [universal-link-authoring-hard-cutover.md](../cutovers/universal-link-authoring-hard-cutover.md))
  is the reader's primary chain-link authoring verb: a fresh selection or an
  existing Highlight opens one searchable target dialog whose results include
  direct Resources, existing Highlights, and passage candidates; confirming a
  result atomically creates/reuses the Highlight, the target's
  `passage_anchor`, and one neutral `origin='user', kind='context'` Link. Media
  rollup (`media_owned_reader_children`) includes viewer-owned `passage_anchor`
  rows for the current media, so a Link into a search-derived passage of this
  document surfaces here too. A cross-document Link anchors once in each
  reader; a same-media Link between two local passages emits two rows, each
  activating the opposite endpoint, with stable identity
  `edge:{edge_id}:anchor:{local_ref}` independent of canonical storage
  direction. Stable Link rows expose Remove and Add/Edit/Remove Link-note
  controls; already-linked targets rank normally and show a textual **Linked**
  state instead of a color-only cue.

### reader settings

- `reader_profiles` stores the global reader preferences for a user, one row
  per user
- shipped fields are `theme`, `font_family`, `font_size_px`,
  `line_height`, `column_width_ch`, `focus_mode`, and `hyphenation`;
  `created_at` is database-clock creation metadata only and is never in the
  DTO — there is no `updated_at`. Profile writes are serialization-order
  last-write-wins, not revisioned (contrast the revisioned `reader_media_state`
  cursor below)
- `focus_mode` is `"off" | "distraction_free" | "paragraph" | "sentence"`
- `hyphenation` is `"auto" | "off"`; `auto` enables `hyphens: auto`
  with `hyphenate-limit-chars: 6 3 3` and `hyphenate-limit-lines: 2`
  on viewports `<= 600px`; `off` disables on every viewport
- the settings page and the media header quick-switch both write the same
  global reader profile through the one capability described below
- theme is global reader theme only; there are no per-media theme overrides

### reader profile bootstrap and recovery

- the authenticated workspace data root (`loadWorkspaceBootstrap`) makes
  `GET /me/reader-profile` (`cache: "no-store"`) a **required** read on the
  normal 30 s server-request deadline — it seeds `ReaderProvider` and
  workspace width restoration, so a failed or malformed read rejects the
  whole bootstrap rather than fabricating a frontend default. Saved-session
  and pane resource seeds stay best-effort.
- `AuthenticatedWorkspaceErrorBoundary` is the client class boundary wrapping
  the authenticated layout's `Suspense`/`WorkspaceBootstrapGate` subtree (a
  same-segment `error.tsx` cannot catch its own layout). On bootstrap failure
  it replaces the shell skeleton with a `role="alert"` region that receives
  focus on mount; Retry runs exactly
  `startTransition(() => { router.refresh(); reset(); })` — `reset()` alone
  would re-render the same rejected tree, so `router.refresh()` re-issues the
  Server Component request first.

### reader profile write coordinator

- `readerProfileSync.ts` is the one pure reducer: strict wire decode, per-field
  patch merge/equality, and the `acknowledged`/`local`
  (`Clean | Deferred | Saving | SaveFailed`) state machine.
  `useReaderProfile.ts` is the one impure coordinator: timers, fetches, the
  attempt watchdog, lifecycle listeners, and revalidation generations.
  Together they are the only client write owner — there is no other save
  path, no frontend default, and no no-op.
- one logical PATCH is in flight at a time, with one latest-merged queue
  behind it. Discrete fields (`theme`, `font_family`, `focus_mode`,
  `hyphenation`) send immediately when idle; continuous fields
  (`font_size_px`, `line_height`, `column_width_ch`) debounce 400 ms idle
  within a 5 s maximum, measured from the first unflushed input. Every PATCH
  sets `keepalive: true` and is awaited.
- a `Saving` attempt carries a 35 s wall-clock watchdog (the BFF's 30 s
  deadline plus margin); expiry invalidates then aborts the attempt and
  converts it to `SaveFailed(AttemptDeadlineExceeded)`, ignoring late
  settlement. Restore never auto-starts a replacement PATCH.
- hidden `visibilitychange`, `pagehide`, and provider teardown flush deferred
  or `SaveFailed` work only when no logical PATCH is in flight, and
  `beforeunload`/`unload` are not used.
- clean-tab resume (`visibilitychange`, `focus`, `pageshow`, `online`)
  coalesces to one no-store GET, only from `Clean`, and adopts the response
  only if an `intentGeneration` captured at request time is still
  unchanged — any intervening local intent outranks the background read.
- `ReaderProvider`/`useReaderContext` expose the public capability: `profile`
  (the optimistic desired projection), `persistence`
  (`Clean | Pending | SaveFailed`), semantic setters
  (`setTheme`, `setFontFamily`, `setFocusMode`, `setHyphenation`,
  `setFontSize`, `setLineHeight`, `setColumnWidth`), and `retrySave()`. There
  is no generic `save(Partial<ReaderProfile>)`; calling `useReaderContext`
  outside its provider throws rather than returning a no-op default.
- controls stay interactive in `Pending` and `SaveFailed`.
- one keyed Feedback presentation (`reader-profile-save`, owned by
  `ReaderProfileSaveFeedback.tsx`) is the save-failure UX: a persistent global
  toast with Retry for `SaveFailed`. It is the only presentation — the Settings
  reader pane renders no inline copy of it.

### reader profile backend contract

- `READER_PROFILE_DEFAULTS` in `python/nexus/services/reader_profile.py` is the one
  preference-default authority (schema-validated, frozen); the seven
  preference columns carry no database default (migration `0181`). A
  missing-row GET returns the defaults without inserting; the first PATCH
  explicitly seeds all seven fields from the same value before applying the
  patch.
- the whole PATCH attempt runs inside `retry_serializable`
  (SELECT → INSERT-or-UPDATE → commit); a concurrent first insert retries the
  whole attempt against `reader_profiles_pkey` rather than upserting or
  taking an explicit lock.
- `ReaderProfilePatch` uses strict Pydantic input
  (`ConfigDict(strict=True, extra="forbid")`): explicit null, unknown fields,
  invalid values, and coercible numeric strings/non-integer numeric forms for
  integer fields are all `400`; an empty `{}` patch is also `400`.
- GET/PATCH accept and return exactly the seven preference fields, nothing
  else — no `updated_at` or other metadata.
- FastAPI's `private_reader_no_store` middleware (matching
  `READER_PRIVATE_NO_STORE_PATH_RE`) stamps `Cache-Control: private, no-store`
  on `/me/reader-profile` and `/media/{id}/reader-state` for
  200/400/401/403 and middleware-caught raw 500 responses; the BFF wraps both
  routes with the shared `privateNoStoreResponse.server.ts` helper, and the
  client GET also requests `cache: "no-store"`.

### focus mode contract

focus mode is driven entirely by `reader_profile.focus_mode`. levels are
discrete and additive: each higher level inherits the chrome reduction of
the lower one and adds dimming.

- `off`: no chrome reduction, no dimming. default.
- `distraction_free`: navbar collapses to icon-only; any sibling panes
  in the workspace slide out of view; reader pane chrome (toolbar, tabs)
  fades on idle and reappears on pointer move; reader column maximizes
  to its configured `column_width_ch`. no paragraph dimming.
- `paragraph`: distraction_free chrome reduction PLUS the paragraph
  nearest the viewport vertical center is rendered at full opacity and
  every other paragraph is rendered at `0.4` opacity.
- `sentence`: distraction_free chrome reduction PLUS the sentence
  nearest the viewport vertical center is at full opacity, the
  containing paragraph at `0.7`, and all other paragraphs at `0.3`.

bindings:

- the keyboard binding `cmd/ctrl+shift+f` cycles `off -> distraction_free
-> paragraph -> sentence -> off`
- pressing `escape` while a non-off focus mode is active returns to `off`
- when an active text selection exists in the reader, focus mode
  auto-suspends (renders as `distraction_free`) and resumes the user's
  configured level when the selection clears
- focus mode respects `prefers-reduced-motion`: dimming transitions snap
  rather than fade
- focus mode persists across reloads via `reader_profile.focus_mode`

### color contrast

reader uses warm-neutral colors that match the app palette and stay off
pure black/white to reduce halation under long sessions.

- light theme tokens (literal hex, independent of app theme):
  `--reader-bg: #faf8f3`, `--reader-text: #1a1916`,
  `--reader-text-secondary: #4a463e`, `--reader-text-muted: #7a7468`,
  `--reader-border: #d8d3c9`, `--reader-border-subtle: #ece8df`,
  `--reader-accent: #7d5e35`, `--reader-accent-hover: #634a29`
- dark theme tokens (literal hex):
  `--reader-bg: #15140f`, `--reader-text: #ebe5d6`,
  `--reader-text-secondary: #c2baa7`, `--reader-text-muted: #8a8270`,
  `--reader-border: #2e2c25`, `--reader-border-subtle: #1f1d18`,
  `--reader-accent: #c4a472`, `--reader-accent-hover: #d4b687`
- both themes meet WCAG AAA for body text (>= 7:1)
- pdf viewport keeps a true-white canvas because the embedded pdf
  content sets its own colors; only the chrome around the canvas adopts
  reader theme tokens

### per-media progress

- Consumption's `reader_cursor.py` is the sole DML owner of
  `reader_media_state`. One row per user/media carries a nullable jsonb
  `locator` and monotonic bigint `revision` (starts `1`). A null locator is an
  internal revisioned `Empty` reset tombstone; PUT never accepts a null/clear
  shape. The explicitly named non-cascading FKs are
  `fk_reader_media_state_user` and `fk_reader_media_state_media`.
  `updated_at` is metadata; `revision` is authority.
- `GET /api/media/{id}/reader-state` returns exactly
  `{state:"Empty",revision>=0}` or
  `{state:"Positioned",revision>=1,locator}` — never raw `null`. Empty
  revision `0` means no row; Empty revision `>=1` is a persisted reset
  tombstone. An unsupported (future) media kind returns
  `400 E_INVALID_REQUEST`; missing/inaccessible media returns masked
  `404 E_MEDIA_NOT_FOUND`.
- `PUT /api/media/{id}/reader-state` takes the bare `CursorWrite` body
  (`{locator, base_revision}` — no wrapping envelope, no optional sibling
  block). Extra fields, old bare locators, and a top-level `null` clear are
  rejected with `400`.
  - Web targets require a canonical UUID identifying a fragment owned by this
    media. A supplied text offset must be within its canonical codepoint length,
    including EOF; an absent offset remains absent. EPUB targets additionally
    require the owned package href and an exact offset or unique source anchor.
    Invalid addresses are rejected before cursor or engagement mutation.
  - Empty + matching `base_revision` writes a Positioned cursor at the next
    revision; only an absent row starts from `0`.
  - A matching `base_revision` replaces the cursor at `revision + 1`.
  - An equal desired locator is idempotent success at the current revision —
    the cursor is not revised, but the save still counts as engagement (next
    bullet).
  - A stale `base_revision` returns `409 E_READER_STATE_CONFLICT` with
    `error.details.current` set to the exact current snapshot; nothing is
    mutated, and no engagement is recorded.
  - On cursor success — including the idempotent equal-locator case — the same
    Consumption transaction touches reader-engagement recency and, for
    non-PDF locators, advances a monotonic whole-document progression
    high-water mark. Cursor, engagement, and any completion-transition fact
    commit together. A stale CAS records none of them. There is no request
    shape that writes engagement without a cursor write, and no `204` path.
  - `ResetProgress` writes a higher-revision Empty tombstone and clears current
    engagement atomically. A stale pre-reset save therefore conflicts instead
    of resurrecting the old position.
- All reader-state responses carry `Cache-Control: private, no-store`, via an
  exact-path FastAPI middleware and the matching header on the Next reader-state
  BFF route.
- Offline reading does not alter this canonical cursor shape or create another
  server cursor row. Android writes through the same `PUT reader-state`, adding
  an optional `expected_reader_generation`: when present, the locked
  `reader_publications.generation` must equal it before the cursor CAS, else
  409 `E_READER_CONTENT_CHANGED`. Changed generation and ordinary revision
  conflict mutate nothing; native checks the account with `GET /api/me` first.
- Native stores one baseline plus one latest pending locator per downloaded
  copy. An offline save is acknowledged only after that pending locator is
  durable. Sync uses the generation fence and canonical revision; it never
  picks a value by timestamp or furthest position. A same-generation conflict
  preserves Canonical and Device choices. A changed or deleted source keeps the
  copy and its pending locator local until confirmed removal. See
  [offline](offline.md).
- `ReaderResumeState` (the `locator` payload) is a discriminated union:
  - `pdf`: `page`, `page_progression`, `zoom`, `position`
  - `web`: `target.fragment_id`, `locations`, `text`
  - `transcript`: `target.fragment_id`, `locations`, `text`
  - `epub`: `target.fragment_id`, `target.href_path`,
    `target.anchor_id: Presence<string>`, `locations`, `text`
- the backend and frontend both reject blank strings, removed flat fields,
  unknown keys, invalid ranges, and media-kind mismatches
- quote context is bounded consistently in backend schemas and the frontend
  strict decoder: `quote` is at most 256 Unicode code points; `quote_prefix`
  and `quote_suffix` are at most 128 each. Oversized values are rejected, not
  truncated.
- `useReaderProgress` is the single browser-side coordinator: single-flight,
  latest-only, revision-aware, with a `500ms` idle / `5s` maximum-wait save
  window and event-driven revalidation on pane activation, `visibilitychange`,
  focus, `pageshow`, and `online`. Pure decoding, equality, and
  conflict/adoption decisions live in `apps/web/src/lib/reader/readerProgress.ts`.
  A clean, dormant reader auto-adopts a newer remote cursor; an active or
  locally dirty reader shows the shared status (`use newer spot` /
  `keep my reading spot`) instead of teleporting. A canonical Empty snapshot
  from `ResetProgress` invalidates pending generations and asks the active
  format adapter to apply its existing cold-start beginning; the client never
  fabricates a locator or revision.

The active format publishes a snapshot only when both visible endpoints are
exact for the current source/layout generation. `Reader` snapshots feed cursor
and activity owners after genuine input. `Restore` and inspection snapshots
may update the desktop Document Map rail or mobile Web/EPUB/PDF position ribbon
without writing progress.

### consumption activity

Reader progress is current-state resume data. It remains independent from
Consumption Activity's bounded historical facts.

- `MediaPaneBody` registers the active reader with the one tab-local
  `activityRecorder`. Reading accrues only while the media pane is active, the
  document is visible and focused, and recent genuine reader input keeps the
  reader eligible.
- Web article, EPUB, PDF, and transcript projections supply their actual
  activity scrollport through one format-neutral adapter contract. Restore,
  navigation, preview, and return intents remain ineligible until genuine
  input returns the source to `Reader`.
- prose taps, source links and control activation do not adopt an inspection
  location; only the explicit status action does. the text leaf and activity adapter share
  one keyboard-direction classifier so activating an inline button with space
  cannot claim a forward reading gesture.
- The adapter projects the same semantic viewport that drives document-position
  presentation; it
  never remeasures a scrollbar, writes spans itself, sends a raw device id, or
  derives completion from dwell.
  Canonical Consumption state remains the completion owner.
- PDF contributes observed time/progress but not exact word traversal. The
  canonical text/document-metrics owners provide word positions for supported
  reflowable content.
- The recorder closes bounded semantic spans into the Consumption-owned,
  account-scoped IndexedDB outbox before upload. Reload, offline operation,
  lifecycle closure, and ambiguous delivery retain the stable capture fact;
  storage failure blocks capture visibly instead of falling back to memory.
  These facts power `/stats`, not cursor restore or reader navigation.

See [consumption-activity.md](consumption-activity.md) for the history
contract and [player.md](player.md) for audio capture ownership.

### progress precedence and URL repair

- the stable entry is `/media/:id`; it never redirects to progress
  parameters
- cold-mount precedence: fresh feature-owned hash/evidence/highlight/apparatus
  target -> Positioned canonical cursor -> coarse cold `?loc`/`?fragment` only
  when the cursor is Empty -> default readable source
- a saved web cursor selects its `target.fragment_id` before exact text restore;
  fragment one is the Empty-cursor default only
- when the canonical cursor supersedes a cold coarse query, pane-local
  replace removes only `loc` and `fragment`, preserving `apparatus`,
  unrelated query state, and hash
- ordinary scrolling never writes the URL; pane Back/Forward is workspace
  traversal and never persists a cursor merely because history moved it — a
  fresh media mount produced by Forward applies the cold-mount precedence
  above
- reader href/repair construction is centralized in
  `apps/web/src/lib/reader/readerLocationHref.ts`, including the Reader Copy
  pane link, which strips only coarse `loc`/`fragment` and preserves
  feature-owned `apparatus` and other query/hash intent

### layered restore order

- epub restores in this order:
  hash `#loc-<section_id>` or `#fragment-<id>` (one-shot, consumed by
  `useReaderTarget`) -> saved exact target snapshot ->
  saved `total_progression`/`position` fallback -> first navigation section

### pane history

Generic `push`/`replace`/Back/Forward mechanics are owned by the workspace
(see [workspace.md](workspace.md)). The reader owns only which operation each
of its location-target writes uses.

- `navigateToSection`, `navigateToWebSection`, apparatus activation, highlight
  activation, and embed activation publish cross-section/cross-fragment hrefs
  through one non-exported seam, `replaceReaderLocation(target)`, in
  `MediaPaneBody`; it calls
  `paneRouter.replace(buildReaderLocationHref(id, target))`. These writes
  update the mounted media visit and add no Back/Forward entry.
- Focus-only branches — highlight, evidence, and transcript-time targets that
  resolve without a cross-section/cross-fragment href — write no href at all;
  they are dismissible focus state owned by `useReaderTarget` and do not push
  pane history.
- Generic same-pane note/resource activation remains a destination `push`,
  even when it resolves to the current media; it is not reinterpreted as
  reader-location state.
- Coarse-query repair — stripping `loc`/`fragment` once a Positioned cursor
  supersedes them — is a separate pane-router replace, not the
  `replaceReaderLocation` seam; it preserves unrelated query state and the
  hash. Target-hash consumption (`useReaderTarget`'s `markActive`) is the
  writer that replaces with `pathname + search`, dropping the consumed hash;
  invalid target cleanup and canonical target normalization go through that
  same hash-consuming replace.
- PDF page and zoom controls remain reader state only; they do not create pane
  history entries unless they intentionally change the pane href.
- once the section is open, epub restores by
  `text_offset` -> quote match -> `progression` ->
  `total_progression` -> `position` -> anchor fallback -> section top
- text restore runs once per open/navigation session and is cancelled on
  genuine user scroll intent, including input that arrives while the cursor or
  layout is still loading and the restore phase is still nominally `idle`;
  delayed restore inputs cannot reclaim a cancelled viewport
- a trusted forward scroll capture wins over a coincident layout/reflow
  generation reset: the new generation retains the intent carried by that
  exact publication, so resize noise cannot swallow or downgrade the reader's
  first canonical move (including an exact terminal locator)
- epub keeps the active section tracked via the in-memory `useReaderTarget`
  target after resolution so intra-pane back/forward describes the active
  section without starting a second restore loop
- the epub active-section target is reader location state inside the
  `media:{id}` pane resource, held in `useReaderTarget` (not the URL).
  synchronizing it must not reset pane chrome, clear route-keyed label/header
  publications, or remount the media pane body.
- web article/transcript restore uses the one-shot hash target first
  (`#fragment-<id>`, `#evidence-<id>`, `#highlight-<id>`, or `#t-<ms>` for
  transcript), consumed by `useReaderTarget`, and falls back to the saved
  `target.fragment_id` when no hash target is present
- web article and epub restore exact canonical offsets after layout settles;
  missing exact coordinates remain unavailable. transcript retains its existing
  time/quote/progression restore contract
- pdf restores in this order: hash `#page-<n>` (one-shot, consumed by
  `useReaderTarget`) -> saved `page`, `page_progression`, and `zoom`. After
  open, later page, intra-page scroll, and zoom changes persist in place
  without reopening the file

### epub reader surface

- `GET /api/media/{id}/navigation` returns one generation, unique source
  fragments, semantic sections, publisher toc, landmarks, and page list.
- `GET /api/media/{id}/fragments/{fragment_id}` loads one render unit, independent
  of its number of headings. the removed section-content route has no adapter.
- publisher targets and headings reconcile by exact source identity. bounded
  numbered entries carry visible `InferredNumberedEntry` provenance.
- exact note bodies and evidenced note groups exclude their subordinate headings
  from routine sections. toc targets remain independently reachable. a linked
  section must begin at the same exact point as its toc target.
- current section is the deepest range containing the exact visible locus.
  unique source positions determine next/previous sections; source fragments
  determine resource continuation, including books without an outline.
- `#loc-<section_id>` addresses a surviving outline identity. explicit passage
  targets use `#text-<fragment_uuid>:<start>:<end>`. internal links carry fragment
  identity and optional source anchor. no approximate target is substituted.
- section activation prefers its retained unique source anchor; codepoints measure
  its position and extent. image-only sections remain distinct inside text-bearing
  fragments. a viewport without a visible text primary has no text percentage
  (apart from a genuine end-of-document witness); it never borrows a later glyph.
- inspection and return do not save progress. one origin survives subsequent
  jumps; failed navigation restores its immediate departure.
  positioning waits for layout readiness, which certifies the mounted section
  dom (after the hosted highlights gate) for the reader instance, fragment and
  typography; a restore that finds no content dom settles instead of waiting,
  so every restore session ends.
  epub section controls and internal source links use the same positioning owner
  and return origin. mobile map jumps keep detail open; closing it never adopts
  the detour.
- media metadata owns workspace labels; fragment loading and semantic section
  context do not rename the pane.

### Android reading copies

`reader_publications` is the sole generation owner for ready PDF, EPUB, and web
article reader inputs. A reading copy (`services/reading_copy.py`, served at
`GET /stream/media/{id}/reading-copy` with a stream token) reads the hosted
navigation, web fragments or EPUB fragments in one repeatable-read snapshot,
serializes each exactly as its hosted route does, releases the snapshot, and
zips them as `reader.json` with `document.pdf` or every `assets/{asset_key}`.
It records the generation it read (`Nexus-Reader-Generation`); an object that
vanished meanwhile is `E_READER_CONTENT_CHANGED`. Web article images become
text placeholders; EPUB html is untouched, and the shelf rewrites its
`/api/media/{id}/assets/` prefix to the copy's own files.

The shelf (`apps/web/src/shelf/`) feeds `reader.json` to the hosted parsers
through `ReaderDocumentSource` and renders with the shared core. It is a build
output, not a committed tree: gradle runs `bun run build:shelf` in `apps/web`
before merging assets, and `./scripts/test` runs the same build. Its CSP and
the native router keep it off the network. See [offline](offline.md).

### reader theme quick-switch

- media More exposes a reader theme quick-switch
- available theme values are light and dark
- it is shown for epub, web article, and transcript readers
- pdf readers keep their existing appearance behavior and do not surface
  this quick-switch
- the switch updates the global reader profile that already drives
  reflowable reader rendering

### web text-anchor resume

web article resume stores canonical text offsets instead of raw viewport
scroll offsets.

flow:

- map DOM text to canonical codepoint offsets
- capture the first and last visible canonical offsets in one DOM pass
- persist the first offset only after genuine reader input
- map the saved offset back to DOM location on restore

this keeps resume robust when typography changes.

### browser extension ingestion

- extension-captured web articles are accepted as pending media with a durable
  `media_source_attempts` row and a private raw-HTML source artifact
- `ingest_media_source` sanitizes captured article HTML, generates canonical
  text, and transitions the media to `ready_for_reading`
- captured private article pages keep `canonical_url: null`
- captured private article pages do not use global canonical-url dedupe
- browser-fetched PDF/EPUB files are accepted as durable source attempts before
  extraction starts
- pasted public X/Twitter post URLs use the official X API full-archive search
  endpoint and materialize as same-author thread web articles through
  `ingest_media_source`
- extension URL capture reuses existing URL classification, including supported video ingestion
- extension auth is scoped, revocable, and only covers capture

## manual regression coverage

when reader behavior changes, manually check the affected behavior from this list:

- reader settings persistence
- web canonical locator resume after reflow from profile typography changes
- epub `#loc-` hash deep link precedence over saved resume
- epub delayed hydration cancellation after manual scroll
- epub intra-section locator resume after reload
- pdf page + zoom + intra-page locator resume after reload
- pdf page changes persisting without reopening the file
- cold `?loc`/`?fragment` loses to an existing Positioned cursor, and repair
  preserves unrelated query/hash state
- clean, dormant cross-device re-entry auto-applies a newer cursor without
  remounting; active/dirty re-entry shows the handoff instead of teleporting
- reader-to-chat quote flow sends `reader_selection` (highlight key + revision)
  from a typed launch intent and captures an immutable per-message snapshot that
  survives reload, branch, and rerun; a geometry-only Highlight is non-sendable
- wrong-generation offline cursor writes leaving the canonical cursor unchanged
- the shelf's local-only request/range routing and explicit text-only-article
  disclosure

## static verification

`./scripts/test` checks static consistency. it does not exercise the reader.
