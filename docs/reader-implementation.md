# reader implementation status

this records the current reader model and the constraints we actively ship.

## constraints we enforce

- line length target: 50-75 chars on desktop
- base font around 16px, with larger user-adjustable options
- line height around 1.4-1.6
- theme support: light and dark
- mobile-safe reader layout and controls
- mobile document-pane chrome policy lives in `docs/mobile-pane-chrome.md`
- resume that survives reflow where possible

## architecture

### reader settings

- `reader_profile` stores the global reader preferences for a user
- shipped fields are `theme`, `font_family`, `font_size_px`,
  `line_height`, `column_width_ch`, and `focus_mode`
- the settings page and the media header quick-switch both write the same
  global reader profile
- theme is global reader theme only; there are no per-media theme overrides

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
  `?loc` deep link -> saved exact target snapshot ->
  saved `total_progression`/`position` fallback -> first navigation section
- once the section is open, epub restores by
  `text_offset` -> quote match -> `progression` ->
  `total_progression` -> `position` -> anchor fallback -> section top
- epub restore runs once per open/navigation session and is cancelled on
  user scroll intent
- epub keeps `?loc` synchronized after resolution so browser back/forward
  describes the active section without starting a second restore loop
- web article/transcript restore uses explicit target params first
  (`fragment_id`, `start`) and falls back to the saved
  `target.fragment_id`
  when no explicit target is present
- web article/transcript visual restore uses
  `text_offset` -> quote match -> `progression` ->
  `total_progression` -> `position`
  after layout settles
- pdf applies saved `page`, `page_progression`, and `zoom` on open,
  then persists later page, intra-page scroll, and zoom changes in place
  without reopening the file

### epub reader surface

- epub reader bootstraps from `GET /api/media/{id}/navigation`
- active epub content loads from
  `GET /api/media/{id}/sections/{section_id}`
- `section_id` is treated as a path-encoded identifier and may contain `/`
- the frontend canonical deep-link is `?loc={section_id}`
- legacy `chapters` and `toc` reader routes are removed from the client surface

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
- pasted public X/Twitter post URLs use official oEmbed HTML and enter `ready_for_reading` immediately as single-post web articles
- extension URL capture reuses existing URL classification, including supported video ingestion
- extension auth is scoped, revocable, and only covers capture

## regression coverage

required e2e coverage includes:

- reader settings persistence
- web canonical locator resume after reflow from profile typography changes
- epub `?loc` deep link precedence over saved resume
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
