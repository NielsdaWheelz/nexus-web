# reader implementation status

this records the current reader model and the constraints we actively ship.

## constraints we enforce

- line length target: 50-75 chars on desktop
- base font around 16px, with larger user-adjustable options
- line height around 1.4-1.6
- theme support: light and dark
- mobile-safe reader layout and controls
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
- locator kinds are:
  - `fragment_offset` for web article/transcript resume
  - `epub_section` for epub section/anchor resume
  - `pdf_page` for pdf page + zoom resume
- `locator_kind: null` clears the stored resume state for that media
- patch schemas reject unknown fields
- db constraints enforce safe locator bounds (`offset`, `page`, `zoom`)

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
- web text-anchor resume after reflow from profile typography changes
- epub chapter resume after reload
- pdf page + zoom resume after reload

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
