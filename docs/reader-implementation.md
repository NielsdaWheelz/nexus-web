# reader implementation status

this records the current reader model and the constraints we actively ship.

URL deep-link targets are one-shot reader focus state consumed by
`useReaderTarget`.

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
- mobile-safe reader layout and controls; mobile document panes keep reader
  controls local to the active pane and do not mount the desktop secondary
- on mobile, highlights are reached through a drawer opened from the reader
  menu or by tapping an existing highlight; the highlights secondary is
  desktop-only
- resume that survives reflow where possible

## architecture

### highlight surfaces

the reader has two right-side highlight surfaces with distinct scopes.

- desktop has an always-on **overview ruler**: a whole-document highlight map,
  one tick per highlight in the entire media, positioned by document fraction,
  with a viewport-position band, a read-only hover preview, and click-to-jump
  that navigates cross-fragment. it is `~28px` wide and present for every
  desktop readable media whether or not highlights exist.
- the **highlights secondary** (`ReaderHighlightsSurface`) is visible-only: it
  shows only highlights in the current viewport, with their notes and actions.
  it is the reader `SecondaryPaneShell` "Highlights" surface, opened on demand
  from the ruler's open-highlights button.
- the ruler and the secondary are decoupled instruments, not two states of one
  widget: *map* (ruler, always on) vs *here, with notes* (secondary, on demand).
- mobile has no ruler. highlights are reached through a drawer opened from the
  reader menu or by tapping an existing highlight; the drawer is the same
  `ReaderHighlightsSurface` component on the same visible-only model.

### workspace pane sizing

The authenticated workspace owns one reader text floor for every non-PDF
desktop pane. It measures the active reader font family, font size, line
height, `column_width_ch`, and reader inline padding with one hidden browser
probe before mounting workspace state. New non-PDF panes default to that floor,
and no non-PDF pane can shrink below it.

PDF panes are the only primary-width exception. `PdfReader` measures rendered
PDF page geometry and publishes the widest rendered page as intrinsic primary
width; the workspace raises the PDF pane floor to that width.

The overview ruler is fixed primary-adjacent chrome: it changes rendered pane
width without changing stored primary pane width. Reader highlights and
document chat are target secondary surfaces under
`docs/workspace-pane-system-consolidation-cutover.md`; their width is independent from the
primary reader width. Mobile panes ignore desktop runtime pane sizing and render
at viewport width.

### overview ruler positioning

the ruler positions each highlight as a fraction `0..1` through the whole
document, computed from stored anchors plus document metadata
(`overviewPositions.ts`), never from rendered DOM geometry.

- web/transcript: cumulative codepoint offset over `fragments` ordered by
  `idx`, length = canonical-text codepoint length
- epub: cumulative `char_count` over navigation sections ordered by `ordinal`;
  a stored highlight anchors by `fragment_id`, and each navigation section
  carries the `fragment_id` of its one fragment, so highlights position
  directly against the section list
- pdf: `(page_number - 0.5) / numPages`; ticks are page-granular
- highlights that cannot be positioned (unknown fragment/section, missing
  `numPages`) are dropped; the rest are sorted ascending by position
- the viewport band spans the active fragment/section's global offset range
  (`documentSpan`), narrowed by the in-fragment scroll fraction
- ruler activation routes through `MediaPaneBody`, which navigates to the
  highlight's fragment/section/page when it is not the active one, then
  dispatches a reader pulse. User-visible reader jumps that change the pane
  href use `paneRuntime.router.push`, so pane Back returns to the previous
  reader location.

### highlight read paths

there are two highlight read paths by design, with different scopes and update
cadences.

- per-fragment: `GET /api/fragments/{id}/highlights` (per-page for pdf), fed
  to inline highlight rendering of the active fragment and the visible-only
  secondary; re-fetched on every fragment switch
- media-wide: `GET /api/media/{id}/highlights` returns every highlight of the
  media across all fragments and pages; fed to the overview ruler only,
  fetched once per media open and after mutations

### anchored highlight projection

Anchored projection is the reader-owned bridge from stored highlight anchors to
visible secondary rows. It is the highlights secondary's mechanism only; the overview
ruler never uses it.

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

### reader settings

- `reader_profile` stores the global reader preferences for a user
- shipped fields are `theme`, `font_family`, `font_size_px`,
  `line_height`, `column_width_ch`, `focus_mode`, and `hyphenation`
- `focus_mode` is `"off" | "distraction_free" | "paragraph" | "sentence"`
- `hyphenation` is `"auto" | "off"`; `auto` enables `hyphens: auto`
  with `hyphenate-limit-chars: 6 3 3` and `hyphenate-limit-lines: 2`
  on viewports `<= 600px`; `off` disables on every viewport
- the settings page and the media header quick-switch both write the same
  global reader profile
- theme is global reader theme only; there are no per-media theme overrides

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

### per-media resume

- `reader_media_state` stores resume only
- `GET/PUT /api/media/{id}/reader-state` uses `ReaderResumeState | null`
- `null` clears the stored resume state for that media
- `ReaderResumeState` is a discriminated union:
  - `pdf`: `page`, `page_progression`, `zoom`, `position`
  - `web`: `target.fragment_id`, `locations`, `text`
  - `transcript`: `target.fragment_id`, `locations`, `text`
  - `epub`: `target.section_id`, `target.href_path`,
    `target.anchor_id`, `locations`, `text`
- the backend and frontend both reject blank strings, removed flat fields,
  unknown keys, invalid ranges, and media-kind mismatches

### layered restore order

- epub restores in this order:
  hash `#loc-<section_id>` or `#fragment-<id>` (one-shot, consumed by
  `useReaderTarget`) -> saved exact target snapshot ->
  saved `total_progression`/`position` fallback -> first navigation section

### pane history

- reader section/TOC jumps that change the active section/page are pane-local
  push navigation. Highlight, evidence, and transcript-time targets are
  dismissible focus state owned by `useReaderTarget`; they do not push pane
  history.
- reader URL repair, invalid target cleanup, and canonical target normalization
  use pane-local replace navigation and do not add Back entries; any `replace`
  navigation must strip the URL hash via the pane router
  (`router.replace(pathname + search)`)
- PDF page and zoom controls remain reader state only; they do not create pane
  history entries unless they intentionally change the pane href
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
  `useReaderTarget`; pane-local EPUB section navigation uses the `?loc=`
  search parameter for active-section history
- legacy `chapters` and `toc` reader routes are removed from the client surface
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

- extension-captured web articles enter `ready_for_reading` immediately
- the server still sanitizes captured article HTML and generates canonical text before persist
- captured private article pages keep `canonical_url: null`
- captured private article pages do not use global canonical-url dedupe
- browser-fetched PDF/EPUB files reuse the existing upload confirm, dedupe, and extraction lifecycle
- pasted public X/Twitter post URLs use the official X API full-archive search endpoint and enter `ready_for_reading` immediately as same-author thread web articles
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

supporting test infra:

- e2e global setup applies migrations before seed
- seed includes dedicated reader-resume fixtures for web/epub/pdf
- flaky pdf reload path is hardened by deterministic post-reload page
  normalization

## validation commands

```bash
make verify
make test-e2e
make test-e2e-ui
```
