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
- one shared, directly visible Companion action in the same resource-header
  position on desktop and mobile
- on mobile, the Resource Inspector sheet is the single secondary detail path;
  the interactive Document Map overview rail remains desktop-only, while
  readable Web, EPUB, and PDF render one passive position ribbon
- resume that survives reflow where possible

## architecture

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

### Pane Find adoption boundary

The shared Pane Search foundation defines `FindOccurrences`, exact
revision-scoped result keys, one immutable **Go back to reading position**
origin, and transient Companion results. Web articles and readable
video/podcast transcripts, EPUBs, and PDFs use that shared lifecycle.

`MediaPaneBody` selects one route-local adapter under one `usePaneFind`
controller. Web searches every loaded canonical fragment and uses one
`SearchPreview` lease beside the existing progress/activity owners. The lease
captures the live origin before the first move and fences cursor persistence
(including lifecycle flush), completion, and activity until the next trusted
reader input. Preview and Return use exact canonical DOM anchors and never call
navigation or URL replacement.

Transcript Find searches timeline-ordered readable fragments and changes only
the active transcript row and the active layout's scroll owner. Mobile preview
and Return position the outer document viewport; desktop positions the bounded
segment list. Both route app-owned movement through `paneScroll.ts`. Find never
seeks, plays, resumes, mounts a progress seam, or creates an activity seam.
Partial coverage is explicit in both zero and nonzero result states. Close
clears marks without returning; Return restores and retires the one origin.

EPUB Find searches canonical fragments through the bounded EPUB Find API.
Cross-section preview uses a rendered-section override, while committed
navigation, URL, restore state, progress, completion, and activity remain
fenced. The first genuine input atomically adopts the rendered section and is
capture-suppressed; later input resumes ordinary reader behavior. Same-section
stepping reuses the rendered section without a request.

PDF Find delegates exact matching and marks to PDF.js while the shared session
owns query, cancellation, preview, and Return. App-owned page, zoom, restore,
and preview positioning runs under `paneScroll.ts`; PDF.js-internal scrolling
remains library-owned.

### canonical Find marks and rebind

Web-article and EPUB Find share one presentation owner,
`canonicalTextFindPresentation.ts`. Its `publish` filters an adapter's logical
occurrences to the rendered fragment, projects each through
`resolveCanonicalTextRanges` against the current cursor, and defects on any range
that is absent, collapsed, disconnected, outside the viewport, or inconsistent
with its nonempty span. It paints every in-fragment passive range and only the
visible active target; it stores no occurrence source of truth. It privately
composes `paneFindHighlightRegistry.ts`, the document-global fixed-name CSS
Custom Highlight aggregate (`nexus-find-all`/`nexus-find-active`) with explicit
active-over-passive priority and owner-scoped clearing. Conversation Find
consumes that lower-level registry directly.

The Web and EPUB adapters expose `rebuildPresentation()`. `MediaPaneBody` owns
one ordered post-commit `useLayoutEffect`: after each committed
`renderedHtml`/fragment change it rebuilds the cursor, republishes the active
format's rendered-state ref from one local validity read, and invokes the
selected canonical (Web or EPUB) rebind before paint. Exact marks therefore
survive same-fragment HTML replacement (delayed persisted-highlight load),
cross-fragment/section preview, and reflow; stale ranges are never retained, and
Find never converts into a persisted Highlight. `page.module.css` styles the
marks with only `::highlight()`-supported properties (`background-color`, not the
`background` shorthand); active is distinguishable without color via a double
underline, and forced colors keeps both marks perceivable while retaining the
active cue. There is no native, DOM-wrapper, or approximate fallback; a missing
CSS Custom Highlight API fails loudly.

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
**Contents** when available, **Evidence**, and **Dossier**. The shared Companion
action opens that group. The reader's internal **Document Map** remains the
owner of Contents, Evidence, and the desktop overview rail; it is not the
generic secondary-pane disclosure contract.

- Desktop has a fixed **Document Map overview rail**. It consumes aggregate
  markers from `GET /media/{id}/document-map`, shows whole-document positions
  for positioned reader facts, and activates the matching contextual target.
  It has no generic opener.
- Contents uses `ReaderContentsNav`.
- Evidence uses `EvidencePaneSurface`. The shipped surface merges highlights,
  source-authored apparatus, and resource-graph connections; its wide-reader
  companion is `MarginRail`.
- Mobile has no interactive Document Map overview rail. The same
  Contents/Evidence bodies render in the Resource Inspector's workspace mobile
  sheet; readable Web, EPUB, and PDF render the passive reader-relative
  position ribbon defined by the
  [mobile ribbon cutover](../cutovers/mobile-reader-position-ribbon-hard-cutover.md).
- `useResourceInspector` supplies the only visible generic control through the
  shared Companion action; no reader-specific toolbar, Options, transcript, or
  overview-rail opener exists.
- The open region id is scoped by primary pane and secondary group. Mobile
  carries the Companion opener as ephemeral return-focus state, focuses the
  active surface tab, and returns to that opener when the sheet closes.
- Chat opens in the conversation pane; it is not a Document Map surface.

### Media Dossier and Abstract

The Dossier tab uses the universal Dossier surface. Above its revisioned content
it renders one compact, read-only **Abstract** from the current Media
Intelligence projection. Building, Ready, Stale, Failed, and Not Available are
typed states; the Abstract has no Generate control or history. The Media
Dossier binding consumes that same projection and fingerprints it in the input
manifest, so the screen and generation engine never perform independent
interpretations of the same Media content version.

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

The compact credit line renders the ordered first two credit items on desktop
and the first one on mobile. Resolved visible credits are native pane links;
unresolved credits are text; noninteractive `+N` counts the unmounted tail.
Each visible name owns its ellipsis. `Credits…` in Options opens the complete,
wrapping, linked credit list. Authorization-gated `Add author…` /
`Edit authors…` opens `MediaAuthorsEditor` separately; author administration is
not inline header content. Both overlays return focus to the exact Options
trigger, with pane chrome as the disconnected-trigger fallback.

The canonical contract for explicit `Passages | Whole document` scope,
semantic filters, and typed related-object disclosures is
[`reader-evidence-scope-associations-hard-cutover.md`](../cutovers/reader-evidence-scope-associations-hard-cutover.md).
Evidence exposes only that target-centered payload; no removed reader lens,
route, or storage-shaped response remains.

### fresh-selection icon toolbar

`SelectionPopover` mounts one `SelectionActionDock` inside
`FloatingActionSurface`. Full-capability selections expose one content-sized,
non-wrapping row of icon-only controls named **Highlight**, **Note**, **Link**,
**Ask**, and **More**; **More** exists only while overflow is non-empty and
opens the shared `ActionMenu` on the text-labeled **Learn**,
**Ask in existing chat…**, and **Share**. The row carries no visible action
text: each control's accessible name is also its native `title`.
`buildHighlightActions` remains the sole capability owner and
`projectSelectionActionPlan` the sole order owner, so an ineligible action is
absent and never promotes an overflow action into the direct row. Density
belongs to the pointer — 32px targets, 16px glyphs, 4px gaps, and 44px targets
under `@media (pointer: coarse)` — never to viewport width or action count. The
dock owns toolbar focus, the overflow trigger, and color disclosure only; color
is a parameter of **Highlight**, shown as an ink bar under its `Highlighter`
glyph rather than as a sibling verb. Readers remain the sole
selection-normalization and Highlight-creation owners. Existing Highlight
surfaces continue to use `HighlightActionBar` and keep their existing labels and
behavior.

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

the `n` chord is reader-local: `useHighlightNoteChord` fires on bare `n`
(no modifiers), guarded by `isEditableTarget`, dispatched where the selection
state lives (`MediaPaneBody` and `PdfReader`). it is deliberately not a
keybindings-registry entry — that registry is app-global and cannot capture
bare keys.

### contents surface

The document table of contents (epub + web article) is the Resource Inspector
**Contents** tab (`ReaderContentsNav`) and remains a Document Map feature.

- it is on-demand through the shared Companion action. When contents exist,
  Media's capability default order selects it first.
- it is available independent of highlights: it shows whenever the document
  has TOC nodes, including focus mode where highlights are hidden.
- selecting an entry runs the existing section/anchor navigation, which
  replaces the pane's active href and adds no Back/Forward entry (see pane
  history).
- mobile reaches Contents through the same Resource Inspector sheet.
- it has no internal scroll container: the secondary body is the single scroll
  owner. the reader prose keeps a single scroll owner (`.documentViewport`);
  the TOC is not rendered inline.

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
generic open control. Contents and Evidence are Document Map bodies inside the
shared Resource Inspector; Dossier is the third Media tab. The single
`resource-inspector` width policy is independent from the primary reader width.
`MarginRail` is wide-reader primary-adjacent evidence presentation, not another
secondary surface. Mobile panes ignore desktop runtime pane sizing and render at
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
is not workspace fixed chrome. Terminal reader content clears the protected
band separately through the element-local
`--mobile-content-bottom-clearance` its pane body publishes. The
[mobile ribbon cutover](../cutovers/mobile-reader-position-ribbon-hard-cutover.md)
owns its semantic range contract and proof; the
[bottom geometry cutover](../cutovers/mobile-reader-bottom-geometry-hard-cutover.md)
owns its placement.

- text is `(fragment_id, canonical codepoint offset)` over ordered unique
  fragments; every fragment contributes its length once
- EPUB navigation sections are targets, not lengths: each carries an exact
  `start_offset`/`end_offset` inside its required fragment; fragments carry
  `char_count`
- PDF is `(one-based page, normalized full-page fraction)`; page gaps, zoom,
  and scrollable-remainder fractions are not document coordinates
- a marker with no exact owner start has no rail marker; no midpoint, ordinal,
  section-top, or scrollbar fallback exists
- the rail receives only markers, a projected visible range, and activation;
  it owns no scroll listener, content observer, `documentSpan`, content ref, or
  position calculation. A track-only `ResizeObserver` recomputes presentation
  clusters after fixed-chrome reflow and reads no document geometry
- overlapping 24px targets form a median-position cluster. Every member is a
  named native button; no primary member is selected implicitly.

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
  `highlight:` reference or later `read_resource` evidence
- reaching a new or existing chat uses workspace canonical-pane adoption: the
  destination pane is reused or opened without duplication, and source
  activation returns to the reader pane from the immutable locator
- a geometry-only PDF Highlight (blank `exact`) is non-sendable as a quote

### anchored evidence projection

Anchored projection is the reader-owned bridge from target-owned locators to
visible Evidence and margin rows. The overview rail owns no DOM geometry:
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

- Backend extraction is owned by `reader_apparatus.py` and the relevant ingest
  path before semantic source attributes are sanitized away.
- Source-authored standalone margin notes are valid target-only apparatus rows:
  they appear in Evidence and can jump to the note target, but they do not get
  invented marker edges or hover previews.
- Evidence exposes apparatus through its `Citations` filter and distinguishes
  source references from generated citations in the typed item contract.
- Web/EPUB rows may support hover previews and marker/target activation when
  exact locators exist.
- PDF rows are capability-gated. Current PDF support is scoped to native
  internal `cite.*` link graphs, arXiv source-package TeX/BibTeX graphs, and
  strict law-review-style same-page legal footnotes with footnote-sized target
  text. Generic PDF superscripts, reference sections, and plain extracted text
  do not create apparatus rows.
- The 20-source support matrix, fixture hashes, and expected counts live in
  `python/tests/fixtures/reader_apparatus/corpus_manifest.json`, not in reader
  prose.

### reader connections

Reader connections are graph-authored linked items for the current media,
separate from source-authored apparatus.

- Backend ownership remains `resource_edges`; the media reader consumes those
  rows only through `GET /media/{id}/document-map`.
- Evidence classifies these rows under semantic `Links` and `Synapses` filters;
  it exposes no storage-shaped `Connections` category.
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
  (`Clean | Deferred | Saving | SaveFailed | Forbidden`) state machine.
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
  or `SaveFailed` work only when no logical PATCH is in flight; `Forbidden`
  is never promoted, and `beforeunload`/`unload` are not used.
- clean-tab resume (`visibilitychange`, `focus`, `pageshow`, `online`)
  coalesces to one no-store GET, only from `Clean`, and adopts the response
  only if an `intentGeneration` captured at request time is still
  unchanged — any intervening local intent outranks the background read.
- `ReaderProvider`/`useReaderContext` expose the public capability: `profile`
  (the optimistic desired projection), `persistence`
  (`Clean | Pending | SaveFailed | Forbidden`), semantic setters
  (`setTheme`, `setFontFamily`, `setFocusMode`, `setHyphenation`,
  `setFontSize`, `setLineHeight`, `setColumnWidth`), and `retrySave()`. There
  is no generic `save(Partial<ReaderProfile>)`; calling `useReaderContext`
  outside its provider throws rather than returning a no-op default.
- controls stay interactive in `Pending` and `SaveFailed`; `Forbidden`
  disables persistence controls and has no Retry until a fresh bootstrap.
- one keyed Feedback presentation (`reader-profile-save`, owned by
  `ReaderProfileSaveFeedback.tsx`) is the save-failure UX: a persistent global
  toast with Retry for `SaveFailed`, one without for `Forbidden`. While the
  Settings reader pane is active it holds a `suppressDedupeKey` lease on that
  key — the global toast is hidden and `SettingsReaderPaneBody` renders the
  same failure inline — and releases the lease on deactivation/unmount,
  restoring the global notice if the failure remains. There is exactly one
  visible live presentation at a time.

### reader profile backend contract

- `READER_PROFILE_DEFAULTS` in `python/nexus/services/reader.py` is the one
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

- Consumption's `_reader_cursor_store.py` is the sole DML owner of
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
- `ReaderResumeState` (the `locator` payload) is a discriminated union:
  - `pdf`: `page`, `page_progression`, `zoom`, `position`
  - `web`: `target.fragment_id`, `locations`, `text`
  - `transcript`: `target.fragment_id`, `locations`, `text`
  - `epub`: `target.section_id`, `target.href_path`,
    `target.anchor_id`, `locations`, `text`
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
  locally dirty reader shows the handoff (`Go to most recent position` /
  `Stay at this position`) instead of teleporting. A canonical Empty snapshot
  from `ResetProgress` invalidates pending generations and asks the active
  format adapter to apply its existing cold-start beginning; the client never
  fabricates a locator or revision.

The active format publishes a snapshot only when both visible endpoints are
exact for the current source/layout generation. `Reader` snapshots feed cursor
and activity owners after genuine input. `Restore`, `Preview`, and `Return`
snapshots may update the desktop Document Map rail or mobile Web/EPUB/PDF
position ribbon but retain their existing no-write, no-activity fences.

### consumption activity

Reader progress is current-state resume data. It remains independent from
Consumption Activity's bounded historical facts.

- `MediaPaneBody` registers the active reader with the one tab-local
  `activityRecorder`. Reading accrues only while the media pane is active, the
  document is visible and focused, and recent genuine reader input keeps the
  reader eligible.
- The adapter projects the same semantic viewport that drives document-position
  presentation; it
  never remeasures a scrollbar, writes spans itself, sends a raw device id, or
  derives completion from dwell.
  Canonical Consumption state remains the completion owner.
- PDF contributes observed time/progress but not exact word traversal. The
  canonical text/document-metrics owners provide word positions for supported
  reflowable content.
- The recorder flushes bounded best-effort batches through the activity BFF;
  it has no durable browser queue. Its facts power `/stats`, not cursor restore
  or reader navigation.

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
- web article/transcript visual restore uses
  `text_offset` -> quote match -> `progression` ->
  `total_progression` -> `position`
  after layout settles
- pdf restores in this order: hash `#page-<n>` (one-shot, consumed by
  `useReaderTarget`) -> saved `page`, `page_progression`, and `zoom`. After
  open, later page, intra-page scroll, and zoom changes persist in place
  without reopening the file

### epub reader surface

- epub reader bootstraps from `GET /api/media/{id}/navigation`
- navigation carries ordered unique `fragments` and exact section targets.
  Fragments own document length; sections carry their required `fragment_id`,
  `start_offset`, and `end_offset`. Repeated headings in one XHTML fragment do
  not duplicate its length.
- active epub content loads from
  `GET /api/media/{id}/sections/{section_id}`
- `section_id` is treated as a path-encoded identifier and may contain `/`
- one-shot reader target hashes use `#loc-{section_id}` and are consumed by
  `useReaderTarget`; pane-local EPUB section navigation replaces the `?loc=`
  search parameter as coarse in-visit address state and adds no Back/Forward
  entry
- removed `chapters` and `toc` reader routes stay out of the client surface
- the pane label and resource-header title are driven by media metadata, not by
  navigation section title or active section content. navigation and section
  loading are content-level states and do not own workspace label/header state.

### reader theme quick-switch

- media Options exposes a reader theme quick-switch
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

## regression coverage

required e2e coverage includes:

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

Supporting proof uses controller-owned per-run state, the canonical corpus, and
the reader-progress/citation journeys.

## validation commands

```bash
./scripts/test changed apps/web/src/lib/reader
./scripts/test changed apps/web/e2e/journeys/reader-progress-resume.journey.spec.ts
./scripts/test changed apps/web/e2e/journeys/highlight-note-provenance.journey.spec.ts
```
