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
- mobile-safe reader layout and controls; mobile document panes render the
  shared Document Map secondary surfaces as a mobile sheet instead of the
  desktop attached secondary pane
- on mobile, the Document Map sheet is the single reader detail path.
  The overview rail remains desktop-only.
- resume that survives reflow where possible

## architecture

### Document Map surfaces

The reader has one side instrument: **Document Map**. It contains Contents,
Highlights, Citations, Connections, and Chat tabs under the existing internal
`reader-tools` secondary group.

- Desktop has a fixed **Document Map overview rail**. It consumes aggregate
  markers from `GET /media/{id}/document-map`, shows whole-document positions
  for every anchored lens, and opens the Document Map.
- The tabbed secondary pane is the detail surface. Contents uses
  `ReaderContentsNav`; Highlights uses `ReaderDocumentMapHighlightsLens`;
  Citations uses `ReaderDocumentMapCitationsLens`; Connections uses
  `ReaderDocumentMapConnectionsLens`; Chat uses the reader document-chat
  owner.
- Mobile has no rail. The same Document Map secondary publication renders in
  the workspace mobile secondary sheet.
- Highlights are one lens of the Document Map, not a separate reader tool.

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
  is the single create-then-verb sequencer; the readers no longer hand-roll
  create-then-quote wrappers.
- pending-create sessions hand the editor a stable opaque session id as its
  `highlightId` and bridge to the real highlight id inside the composer's
  save wrapper once the concurrent create resolves; the editor is never
  re-keyed mid-session.
- Esc, click-outside, scroll, and sheet dismissal flush pending edits and
  save — there is no discard path. an empty composer creates no note; the
  highlight survives in every branch.
- all note writes flow through the canonical `saveHighlightNote` path used by
  Document Map Highlights, so composer-written notes appear there with no extra
  wiring.

the `n` chord is reader-local: `useHighlightNoteChord` fires on bare `n`
(no modifiers), guarded by `isEditableTarget`, dispatched where the selection
state lives (`MediaPaneBody` and `PdfReader`). it is deliberately not a
keybindings-registry entry — that registry is app-global and cannot capture
bare keys.

### contents lens

The document table of contents (epub + web article) is the Document Map
"Contents" tab (`ReaderContentsNav`).

- it is on-demand through the single reader toolbar/menu "Document Map"
  affordance. When contents exist, generic Document Map open defaults here.
- it is available independent of highlights: it shows whenever the document
  has TOC nodes, including focus mode where highlights are hidden.
- selecting an entry runs the existing section/anchor navigation, which
  replaces the pane's active href and adds no Back/Forward entry (see pane
  history).
- mobile reaches Contents through the same Document Map secondary sheet.
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
width; the workspace raises the PDF pane floor to that width.

The Document Map overview rail is fixed primary-adjacent chrome: it changes
rendered pane width without changing stored primary pane width. Reader
highlights and resource chat are Document Map secondary surfaces under the
workspace secondary pane contract ([workspace.md](workspace.md)); their width
is independent from the primary reader width. Mobile panes ignore desktop
runtime pane sizing and render at viewport width. Mobile workspace mode also
suppresses fixed primary chrome, desktop-attached secondary columns, and pane
resize handles; the Document Map reaches mobile through the workspace
secondary sheet.

### overview rail positioning

The aggregate service positions each anchored Document Map marker as a fraction
`0..1` through the whole document, computed from owner locators and document
metadata, never from rendered DOM geometry.

- web/transcript: cumulative codepoint offset over `fragments` ordered by
  `idx`, length = canonical-text codepoint length
- epub: cumulative `char_count` over navigation sections ordered by `ordinal`;
  a stored highlight anchors by `fragment_id`, and each navigation section
  carries the `fragment_id` of its one fragment, so highlights position
  directly against the section list
- pdf: `(page_number - 0.5) / numPages`; markers are page-granular
- unanchorable items remain in their tabs but do not produce rail markers
- the viewport band spans the active fragment/section's global offset range
  (`documentSpan`), narrowed by the in-fragment scroll fraction
- rail activation routes through `MediaPaneBody`, opens the matching Document
  Map tab, and then delegates to that lens's existing activation path.

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

quote-to-chat is highlight-first. The reader creates or reuses a durable
highlight, adds `highlight:<id>` as the document-chat reference, and sends a
transient `reader_selection` turn anchor for the current chat run.

- `reader_selection` carries `media_id` and `highlight_id`; the backend
  canonicalizes prefix, exact, suffix, and source from the highlight row before
  rendering `<reader_selection>`
- the selection is bind-only context for phrases like "this" or "the quote";
  it is never persisted as a reference and never receives a citation ordinal
- citation chips point at the attached `highlight:` reference or later
  `read_resource` evidence, not at the transient selection block
- PDF quote-to-chat passes the freshly created highlight payload through the
  same path as web and EPUB so a just-created quote does not depend on a stale
  highlight-list refresh

### anchored highlight projection

Anchored projection is the reader-owned bridge from stored highlight anchors to
visible secondary rows. It is the Highlights lens mechanism only; the overview
rail never uses it.

- Reflowable readers project highlights from rendered DOM segments tagged with
  `data-active-highlight-ids`.
- PDF readers project highlights from visible page geometry and the current PDF
  viewport transform.
- Projection remeasures after reader typography, active fragment/section,
  rendered HTML, PDF zoom/page render epoch, active secondary surface, secondary
  width, or highlight data changes.
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
  they appear in the Document Map Citations lens and can jump to the note
  target, but they do not get invented marker edges or hover previews.
- The reader exposes apparatus in the Document Map `Citations` tab.
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
- The reader exposes connections in the Document Map `Connections` tab.
- Rows align to the referenced passage when the media-owned endpoint resolves
  to PDF geometry or exact rendered fragment text offsets. Unanchorable rows
  stay in the same list below anchored rows instead of inventing locator data.
- Activating a row opens the source object; activating its target uses the
  target-owned reader locator. Edges never store reader locators.

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

- `reader_media_state` stores one canonical cursor row per user/media: a
  non-null jsonb `locator`, a monotonic bigint `revision` (starts `1`), and
  explicitly named non-cascading FKs (`fk_reader_media_state_user`,
  `fk_reader_media_state_media`). `updated_at` is metadata, not a conflict
  token; `revision` is authority.
- `GET /api/media/{id}/reader-state` returns exactly
  `{state:"Empty",revision:0}` or `{state:"Positioned",revision>=1,locator}` —
  never raw `null`. An unsupported (future) media kind returns
  `400 E_INVALID_REQUEST`; missing/inaccessible media returns masked
  `404 E_MEDIA_NOT_FOUND`.
- `PUT /api/media/{id}/reader-state` takes the bare `CursorWrite` body
  (`{locator, base_revision}` — no wrapping envelope, no optional sibling
  block). Extra fields, old bare locators, and a top-level `null` clear are
  rejected with `400`.
  - Empty + `base_revision: 0` creates revision `1`.
  - A matching `base_revision` replaces the cursor at `revision + 1`.
  - An equal desired locator is idempotent success at the current revision —
    the cursor is not revised, but the save still counts as engagement (next
    bullet).
  - A stale `base_revision` returns `409 E_READER_STATE_CONFLICT` with
    `error.details.current` set to the exact current snapshot; nothing is
    mutated, and no engagement is recorded.
  - On cursor success — including the idempotent equal-locator case — the
    route composes one retry-safe reader-engagement command in its own
    transaction: it touches that (viewer, media) row's recency unconditionally
    and, for non-PDF locators, advances a monotonic whole-document progression
    high-water mark. This follow-up write is not swallowed on failure; the
    same PUT may simply be retried, since both the cursor write and the
    engagement command are themselves idempotent. There is no longer any
    request shape that writes engagement without a cursor write alongside it,
    and no `204` response path.
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
  `Stay at this position`) instead of teleporting.

### progress precedence and URL repair

- the stable entry is `/media/:id`; it never redirects to progress
  parameters
- cold-mount precedence: fresh feature-owned hash/evidence/highlight/apparatus
  target -> Positioned canonical cursor -> coarse cold `?loc`/`?fragment` only
  when the cursor is Empty -> default readable source
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
- epub restore runs once per open/navigation session and is cancelled on
  user scroll intent
- epub keeps the active section tracked via the in-memory `useReaderTarget`
  target after resolution so intra-pane back/forward describes the active
  section without starting a second restore loop
- the epub active-section target is reader location state inside the
  `media:{id}` pane resource, held in `useReaderTarget` (not the URL).
  synchronizing it must not reset pane chrome, clear tab/header title records,
  or remount the media pane body.
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
- navigation sections carry `fragment_id`, so an epub highlight can be mapped
  to its section
- active epub content loads from
  `GET /api/media/{id}/sections/{section_id}`
- `section_id` is treated as a path-encoded identifier and may contain `/`
- one-shot reader target hashes use `#loc-{section_id}` and are consumed by
  `useReaderTarget`; pane-local EPUB section navigation replaces the `?loc=`
  search parameter as coarse in-visit address state and adds no Back/Forward
  entry
- removed `chapters` and `toc` reader routes stay out of the client surface
- pane titles are driven by media metadata, not by navigation section title or
  active section content. navigation and section loading are content-level
  states and do not own workspace tab/header title state.

### reader theme quick-switch

- the media header dropdown exposes a reader theme quick-switch
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

- map dom text to canonical codepoint offsets
- persist the first visible canonical offset while reading
- map canonical offset back to dom location on restore

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
- reader-to-chat quote flow sends a durable `highlight:` reference and, when
  the highlight has nonblank exact text, a transient `reader_selection`
  carrying `media_id` and `highlight_id`

supporting test infra:

- e2e global setup applies migrations before seed
- seed includes dedicated reader-resume fixtures for web/epub/pdf
- flaky pdf reload path is hardened by deterministic post-reload page
  normalization

## validation commands

```bash
cd apps/web && bunx vitest run --project unit src/lib/reader/readerProgress.test.ts src/lib/reader/readerLocationHref.test.ts src/lib/reader/types.test.ts src/lib/media/readerNavigation.test.ts
cd apps/web && bunx vitest run --project unit src/lib/conversations/chatRunBody.test.ts src/lib/api/sse/events.test.ts src/lib/conversations/citations.test.ts
cd apps/web && bunx vitest run --project browser 'src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx' 'src/app/(authenticated)/media/[id]/TextDocumentReader.test.tsx' src/components/reader/ReaderDocumentMapOverviewRail.test.tsx src/components/reader/document-map/ReaderDocumentMapHighlightsLens.test.tsx
make test-e2e PLAYWRIGHT_ARGS='tests/reader-progress-continuity.spec.ts --project=chromium'
make test-e2e PLAYWRIGHT_ARGS='tests/quote-attach-references.spec.ts tests/pdf-reader.spec.ts --project=chromium'
```
