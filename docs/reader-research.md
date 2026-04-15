# reader experience research -> implementation

this document captures the reading constraints we chose to ship and the
system shape they imply.

## objectives

- improve long-form reading comfort on desktop and mobile
- preserve comprehension under reflow
- keep resume deterministic across web, epub, and pdf
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

### per-media resume

- `reader_media_state` stores resume only
- locator kinds are:
  - `fragment_offset` for web article/transcript resume
  - `epub_section` for epub section/anchor resume
  - `pdf_page` for pdf page + zoom resume
- `locator_kind: null` clears the stored resume state for that media

### reflow-safe web resume

web article resume uses canonical text offsets instead of raw scroll
pixels.

- map rendered dom text to canonical codepoint offsets
- persist the first visible canonical offset as resume state
- restore by mapping that offset back to dom position

this makes resume resilient to font-size, line-height, and column-width
changes.

### epub and pdf resume

- epub stores section ids and restores to the resolved section
- pdf stores page and zoom with bounded validation

## regression strategy

required automated coverage includes:

- reader settings persistence
- web article resume after profile typography reflow
- epub chapter resume after reload
- pdf page + zoom resume after reload

## validation commands

```bash
make verify
make e2e
```
