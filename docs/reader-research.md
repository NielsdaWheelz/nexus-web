# reader experience research -> implementation

this document captures the reading constraints we chose to ship and the
system shape they imply.

## objectives

- improve long-form reading comfort on desktop and mobile
- preserve comprehension under reflow
- keep resume deterministic across web, transcript, epub, and pdf
- keep the reader system small enough to understand quickly

## distilled constraints

- line length: target 50-75 characters per line on desktop
- font size: default around 16px, with user-adjustable larger sizes
- line height: keep body text around 1.4-1.6
- themes: ship high-contrast light and dark modes only
- layout: prioritize a single-column continuous reading surface
- mobile ergonomics: preserve readability and controls at narrow widths
- active reading: highlights and resume must survive typography changes

research can support softer tinted backgrounds, but that does not justify
the additional product and maintenance complexity here. the shipped system
intentionally stays with two reader themes: light and dark.

## shipped architecture

### global reader profile

- `reader_profile` stores the global reader preferences for a user
- shipped fields are `theme`, `font_family`, `font_size_px`,
  `line_height`, `column_width_ch`, and `focus_mode`
- all reflowable reader appearance comes from this single source of truth
  across web article, transcript, and epub readers

### per-media resume

- `reader_media_state` stores resume only
- the post-cutover API shape is a single nullable flat locator object
- `null` clears stored resume for that media
- text readers persist `source`, `text_offset`, quote context,
  `progression`, `total_progression`, and coarse `position`
- pdf persists `page`, `page_progression`, `zoom`, and coarse `position`

### reflow-safe web resume

web article resume uses canonical text offsets instead of raw scroll
pixels.

- map rendered dom text to canonical codepoint offsets
- persist the first visible canonical offset as resume state
- restore by mapping that offset back to dom position

this makes resume resilient to font-size, line-height, and column-width
changes.

### layered epub/web/pdf resume

- epub resolves in this order:
  `?loc` deep link -> saved `source` match -> coarse fallback -> first section
- once the section is open, epub restores by exact text offset,
  then quote context, then progression, then anchor
- web/transcript pick explicit fragment/time targets first and fall back
  to the saved text locator otherwise
- pdf restores saved page, intra-page progression, and zoom on open and
  persists later page changes without reopening the document file

### epub request surface

- epub navigation is sourced from `GET /api/media/{id}/navigation`
- epub section content is sourced from
  `GET /api/media/{id}/sections/{section_id}`
- `section_id` is path-encoded and may contain `/`
- `?loc={section_id}` is the canonical deep-link shape
- the reader no longer depends on legacy chapter manifests or toc fetches

## regression strategy

required automated coverage includes:

- reader settings persistence
- web article canonical locator resume after profile typography reflow
- epub `?loc` precedence over saved resume
- epub intra-section locator resume after reload
- pdf page + zoom + intra-page locator resume after reload
- pdf in-session page persistence without file reopen

## validation commands

```bash
make verify
make test-e2e
make test-e2e-ui
```
