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
  read once from one snapshot, never mixed with another read.
- **placement**: where the eye is, `{identity, point, topPx, zoom}`. measured, never
  stored. capture and return use it.
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
  and pulses are css custom highlights.

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
  chrome/              MapRail + PositionRibbon · Contents + SourceIssuesNotice
lib/canonicalText      domTextCursor, domTextRanges, codepoints (dom ↔ canonical offsets)
lib/find               useFind, FindBar contract, highlightPainter (shared by every pane)
```

`lib/documentReader/**` may not import `@/app/*`, `lib/api/client`, `lib/auth`,
`lib/panes` or `lib/workspace` (eslint `no-restricted-imports`): hosts adapt the
workspace to the ports, the primitive never reaches for it.

the runtime is a plain object; react reads it through `subscribe`/`getState`
(`useSyncExternalStore`). surfaces register a `SurfaceHandle` (`capture`,
`position`, `find`, pdf `setZoom`) and report viewports and input.

## server contracts

| route | contract |
| --- | --- |
| `GET /media/{id}/reader` | the whole publication from one snapshot: text (`units` with `html_sanitized`, `canonical_text`, `char_count`, times and speakers for transcripts, `sections`, `toc_nodes`, `source_issues`, `embeds`) or pdf (`file`, `page_count`). typed `Data[ReaderTextDocumentOut \| ReaderPdfDocumentOut]`. |
| `GET /media/{id}/file` | a fresh signed pdf url `{url, expires_at}`; called only after a fetch failed. |
| `GET/PUT /media/{id}/reader-state` | the cursor: `{state: Empty \| Positioned, revision, locator?}`; PUT `{locator, base_revision}` compares and sets; a stale base is `409 E_READER_STATE_CONFLICT` with `details.current`. |
| `GET /media/{id}/document-map` | `{media_id, identity, status, embeds, evidence, markers, diagnostics}`: the annotation evidence (highlights, citations, links, discovery connections, source references) grouped by resolved passage, and the rail markers. no navigation inside. |
| `POST /media/{id}/highlights` | `{anchor: {kind: text, unit_id, start_offset, end_offset} \| {kind: pdf, page_number, quads, exact}, color}` → `201 Data[TypedHighlightOut]`. the unit must belong to the media. |
| `GET/PATCH/DELETE /highlights/{id}` | read, recolour or rebound (`anchor: fragment_offsets`), delete. |
| `GET /media/{id}/reader-targets/{kind}/{target_id}` | a deep link inside this media resolved to `Text{unit_id, start_offset, end_offset} \| Pdf{page_number, quads} \| Time{start_ms, end_ms}`; kinds `highlight`, `evidence`, `passage`, `apparatus`; 404 when it does not resolve here. |
| `GET /public/resource-share/document` | the public reader's one read (token header). |

the old incremental reads (`/fragments`, `/fragments/{id}`, `/navigation`,
`/evidence/{span}`, fragment and pdf highlight lists and creates, the highlight
reader-target route) are gone. a text highlight whose fragment cache is gone is
listed in Evidence as unavailable (`Stale`), never painted.

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

**open and restore.** the runtime awaits the source, the cursor and the fresh
entry together, mounts the surface, then restores once: a fresh target (hash,
pending chat pulse, `?apparatus_id`, resolved through `reader-targets`) enters
exploring with the saved cursor as origin; else a positioned cursor applies;
else a cold target (`?fragment`) applies; else the start. a cursor naming a unit
this publication lacks opens at the start with *saved reading spot unavailable*
and saves nothing until genuine input. any genuine input before restore skips it.
after arrival the text surface pins the placement against late layout (images,
fonts, units rendering at their real height) for 3 s or until input.

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
rail markers, find, home/end and scrollbar seeks call `reader.inspect(target)`:
capture the departure, flush an eligible unsaved locator, enter exploring (the
first origin is kept across later jumps), position, roll back on failure. the
status strip says *reading spot held · section, page n or nn%* with *back to your
spot*, *continue reading here* and *keep inspecting*. choosing a transcript
segment's time stamp is reading from there (`readFrom`): the cursor moves and the
player seeks and resumes. a click on the text itself only selects (words, marks).

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
units near the viewport.

**pdf surface.** pdf.js `PDFViewer`; zoom 0.5–2 in quarter steps (a stored zoom
outside is clamped; `null` while fitted to the width, so a position reopens fitted
anywhere); fitted pages refit when the pane resizes, and the host's chrome is held
while pdf.js scales (its scroll is not reading); links and `#page=`/`#nameddest`
destinations route through `inspect`; a file that fails to open is retried once
with a fresh url from the source; the hosted pane asks for the width that shows
the widest page at scale 1 (or at its zoom); positions locate pages by their boxes
(pdf.js's current page lags a scroll); marks are per-page overlay rects
(`data-reader-mark`, class `hl-<colour>`) under the text layer, hit-tested in page
space; pages keep their source colours.

**selection.** `selectionchange` (120 ms desktop, 400 ms phone) → a capture clipped
to one unit (or one pdf page: quads plus `exact`) → the host's dock. the host acts
on the retained capture, never the live selection. focus dimming is suspended
while a selection is live.

**find.** the attached surface publishes a `FindSource` into reader state; the
host passes it to `useFind`. text matches canonical text with `lib/find`
(narrow scope: this chapter or section); pdf uses pdf.js matching with a scoped
controller that never scrolls (narrow scope: this page); an aborted pdf search
rejects instead of hanging. reveal is an inspect. a partial transcript says so.

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
  evidence, pulse); the document (re)mounts (a new painter); a unit enters or
  leaves the window one viewport above and below the visible band
  (`IntersectionObserver`). width,
  font, line height, column, theme and rotation need nothing: static ranges follow
  the text.
- **priorities:** `hl-<colour>` −4, `hl-hover` −3, `hl-evidence`/`hl-focus`/
  `reader-pulse` −2, `reader-focus` −1 (colour-setting dimming above background
  tints), `nexus-find-all` 0, `nexus-find-active` 1.
- **colours are literal** (chromium and android webview ≤ 113 ignore `var()` in
  `::highlight`); dark inks under `.frame[data-theme="dark"]`. focus is an
  underline, evidence a dotted underline, hover a translucent tint, the pulse a
  1.2 s js toggle. highlight pseudos carry no radius, outline, shadow or
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

| file | owns |
| --- | --- |
| `MediaPaneBody.tsx` | composition: media record (+ processing stream, metadata re-read), the reader, annotations, arrivals, find, evidence/contents bodies, render states, banners, end of document and the lectern prompt |
| `hostedReader.ts` | `hostedSource`, `hostedProgress`, the one locator → target map (`targetOfGroup`, pulses), deep links: `useReaderEntry` (hash `#highlight-\|#evidence-\|#passage-<id>`, `#fragment-\|#text-<id>[:s:e]`, `?fragment`, `?apparatus_id`, pending pulse; read once per mount, consumed with one replace) and `useLiveReaderTargets` (later pulses and hash pushes, the same link again included; a query pushed into an open pane is not read: nothing in the app emits one) |
| `annotations.ts` | `AnnotationStore`: one document-map read → marks of every visible highlight (topmost first), note refs, rail markers, evidence; writes paint at once from their acknowledgement through a pending ledger that a map read issued after the write settles; a failed read keeps the last map painted; `twin` finds the viewer's own highlight of an exact extent (a library-mate's never blocks theirs) |
| `useAnnotationVerbs.ts` | selection and mark verbs: highlight, note (created under the open editor), link (creates nothing until confirmed), ask, ask in existing chat, learn, share, note chord `n`; app-global highlight intents while the mark is mounted |
| `SelectionDock.tsx` | the dock (Highlight with colours, Note, Link, Ask, More), the quick note (floating or sheet), the highlight menu, the overlap chooser, recolour dialog, link dialog, chat chooser |
| `evidence/` | Evidence: type filters, all items / follow text, passage groups in document order (*go to passage*), whole-document items, *needs attention*; rows by kind with actions, notes, source notes and associations |
| `chrome.tsx` | pane chrome: header, section or pdf instrument, find, inspector bodies, view menu (activity, reader settings, theme), the 52 px document-map rail (desktop), pdf intrinsic width, keys (`g`, `g e`, `g c`/`shift+G`, cmd/ctrl+shift+F, shift+Esc, Esc) |
| `Transcript.tsx` | transcript states and request; playback, show notes with seekable times, chapters following the player |
| `activity.ts` | consumption activity from reader viewports (word ordinal when reading) |
| `Embeds.tsx` | embed cards |

deep-link arrivals focus a highlight, underline evidence, or flash a passage; a
target that no longer resolves says *That passage is no longer available.* an
arrival that moves a transcript also moves playback there (a time target's start,
else its segment's), without resuming; a video seeks its embed instead of the
global player. a map measured against another publication is re-read before
anything paints.

## around the reader

- **mobile chrome.** the host's `ReaderHost.scrollport` registers the surface's
  scroll element with the mobile chrome (`lib/mobileShell/chrome.tsx`), which
  alone owns collapse and reveal; programmatic positioning takes one of its
  holds (`holdChrome`). see [workspace.md](workspace.md#mobile-reader-chrome).
- **consumption activity.** reading time accrues only while the pane is active,
  visible and focused, after genuine input within five minutes; reading viewports
  add the document fraction and word ordinal. inspection counts time only. see
  [consumption-activity.md](consumption-activity.md).
- **quote to chat.** a quote is a durable highlight first; the chat send captures an
  immutable per-message snapshot of it (`reader_selection = {media_id,
  highlight_id, revision}`), so later edits never change a sent quote.
- **offline copies.** a reading copy zips the same `GET /media/{id}/reader`
  document; the shelf maps it with `readerDocument()` and renders the same
  `DocumentReaderView` with a device progress port. see [offline](offline.md).
- **theme.** two reader themes, warm-neutral, never pure black on white; literal
  tokens on `.frame[data-theme]` in `documentReader.module.css`. pdf pages keep
  their source colours.

## verification

- `./scripts/test` (static: types, lint incl. the import rule, generated wire,
  unit tests, builds of the shelf and the extension). it does not exercise the
  reader.
- the live harness (isolated stack, playwright-managed browsers): the `R.*`
  reader journeys per surface, `S.*` public shares, `O.*` shelf copies, the
  `G/W/E/P/T/C/D` find subset, and `R.HL.*` for the paint conditions (paint,
  reflow, mutate, static, lazy, hit, select, find, shadow) on chromium, firefox
  and webkit.
- by hand: android webview paint and taps (literal colours, ≥ api 34 emulator and
  a current phone), real safari.
