# reader implementation status

this translates the reader research into concrete engineering constraints and records what is currently shipped.

## constraints we enforce

- line length target: 50-75 chars on desktop
- base font around 16px, with larger user-adjustable options
- line height around 1.4-1.6
- theme support: light, dark, sepia
- scroll and paged reading modes
- mobile-safe reader layout and controls
- resume that survives reflow changes where possible

## architecture

### mobile reader shell contract

- bottom navigation is fixed to the viewport bottom; desktop sidebar is disabled on narrow viewports
- tab management uses a mobile tabs sheet (open tabs list + sign-out action)
- only the active workspace group is visible on mobile to keep one primary pane in view
- split surfaces hide secondary panes behind a right-side drawer toggled from pane chrome actions
- pane/page chrome remains at the top but auto-hides on downward scroll and restores on upward scroll
- highlight editing on mobile uses a sheet-style editor with annotation support
- text selection actions support both highlight creation and immediate quote-to-chat
- pdf viewer on mobile uses `page-width` auto-fit for the initial scale instead of the persisted numeric zoom (user can still manually zoom after load); the viewport uses `dvh` units with a `vh` fallback for correct height under mobile browser chrome

### desktop reader shell contract

- media reader uses a side-by-side split with a resizable linked-items column
- linked-items column can be hidden and restored from a pane chrome action

### reader state split

- `reader_profile`: per-user defaults (theme, font, line height, column width, focus mode, default view mode)
- `reader_media_state`: per-media overrides + location state (locator + payload)

### locator contract

- `fragment_offset` for web article/transcript resume
- `epub_section` for epub section/anchor resume
- `pdf_page` for pdf page + zoom resume

validation and storage hardening:

- patch schemas reject unknown fields
- null-handling is explicit for clearable overrides
- db constraints enforce safe locator bounds (`offset`, `page`, `zoom`)

### web text-anchor resume

web article resume now stores canonical text offsets instead of raw viewport scroll offsets.

flow:

- map dom text to canonical codepoint offsets
- persist first visible canonical offset while reading
- map canonical offset back to dom location on restore

this keeps resume robust when typography changes (font size, line height, column width).

## regression coverage

required e2e coverage now includes:

- reader settings persistence (`default_view_mode`)
- web text-anchor resume after reflow
- epub chapter resume after reload
- pdf page + zoom resume after reload

supporting test infra:

- e2e global setup applies migrations before seed
- seed includes dedicated reader-resume fixtures for web/epub/pdf
- flaky pdf reload path hardened by deterministic post-reload page normalization

## validation commands

```bash
make verify
make e2e
```
