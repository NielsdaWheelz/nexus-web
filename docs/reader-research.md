# reader experience research -> implementation

this document captures the reading constraints we chose to ship and the
system shape they imply.

## objectives

- improve long-form reading comfort on desktop and mobile
- preserve comprehension under reflow
- keep resume deterministic across web, transcript, epub, and pdf
- keep the reader system small enough to understand quickly

## distilled constraints

- line length: target 50-75 characters per line on desktop; 60ch on mobile
- font size: default around 16px, with user-adjustable larger sizes
- line height: keep body text around 1.4-1.6
- themes: ship high-contrast light and dark modes only
- layout: prioritize a single-column continuous reading surface
- mobile ergonomics: preserve readability and controls at narrow widths
- active reading: highlights and resume must survive typography changes
- paragraph spacing: block style only; gap between paragraphs equals one
  line-height; no first-line indent; no extra blank lines
- text alignment: left-aligned, ragged right; no user toggle for justify
- hyphenation: off on desktop (column ≥ 65ch); on for narrow viewports
  (≤ 600px) using `hyphens: auto` with
  `hyphenate-limit-chars: 6 3 3` and `hyphenate-limit-lines: 2`;
  user can disable globally for accessibility
- focus mode: three discrete levels (distraction-free, paragraph,
  sentence) plus off; shortcut Cmd/Ctrl+Shift+F; auto-suspend during
  active text selection so annotation flow is uninterrupted
- contrast: high but not maximal; never pure black on pure white; reader
  surface stays in the warm-neutral family used by the rest of the app

research can support softer tinted backgrounds, but that does not justify
the additional product and maintenance complexity here. the shipped system
intentionally stays with two reader themes: light and dark.

## research basis for the typography rules

- left-align is the screen-reading consensus (Reynolds & Walker 2004,
  Bernard et al. 2002): justified text on screen reduces reading speed
  ~5-10% because browser line breaking lacks Knuth-Plass and proper
  hyphenation, producing rivers and irregular spacing
- block paragraph spacing chunks aids working-memory consolidation
  (Mayer's cognitive theory of multimedia learning); indent vs block is
  null on comprehension when leading and measure are correct, so we
  pick block to match scroll-based reading
- hyphenation has no comprehension effect on left-aligned text at long
  measure (Beier & Larson 2010); enabling it costs aesthetic clarity
  on desktop and helps it on narrow mobile measure
- focus mode levels are evidence-graded: distraction-free is strongly
  supported by cognitive-load theory (Sweller, Mayer); paragraph and
  sentence focus are HCI-suggestive (improved careful reading at the
  cost of overall pace), so they are opt-in not default
- annotation is the largest retention lever (generation effect,
  Slamecka & Graf 1978; testing effect, Roediger & Karpicke 2006); the
  reader's chrome must keep annotation frictionless, which is why focus
  mode auto-suspends during selection

## color and contrast

the reader path uses a warm-neutral palette aligned with the app shell
rather than the prior cool slate/catppuccin palette. high contrast
without halation: text and background never sit at pure black or pure
white because pure values amplify perceived halation and increase
fatigue under long sessions.

- light reader theme:
  - background `#faf8f3` (warm off-white, never `#ffffff`)
  - body text `#1a1916` (warm near-black; ~13.5:1 contrast on background)
  - secondary text `#4a463e`
  - muted text `#7a7468`
  - accent `#7d5e35` (matches app accent)
- dark reader theme:
  - background `#15140f` (warm near-black, never `#000000`)
  - body text `#ebe5d6` (warm cream; ~13:1 contrast on background)
  - secondary text `#c2baa7`
  - muted text `#8a8270`
  - accent `#c4a472` (matches app accent)

both themes meet WCAG AAA for body text. the warm cast reduces blue-light
fatigue and matches the app's editorial palette so the boundary between
shell and reader is calm rather than abrupt. reader colors are still
exposed as `--reader-*` custom properties so that user font-family,
font-size, line-height, and column-width settings can be applied without
touching app theme tokens.

## shipped architecture

### global reader profile

- `reader_profile` stores the global reader preferences for a user
- shipped fields are `theme`, `font_family`, `font_size_px`,
  `line_height`, `column_width_ch`, `focus_mode`, and `hyphenation`
- `focus_mode` is one of `"off" | "distraction_free" | "paragraph" | "sentence"`
- `hyphenation` is one of `"auto" | "off"`; default `auto` enables only
  on viewports `<= 600px`; `off` disables on every viewport
- all reflowable reader appearance comes from this single source of truth
  across web article, transcript, and epub readers

### per-media resume

- `reader_media_state` stores resume only
- the reader-state API is `ReaderResumeState | null`
- `null` clears stored resume for that media
- text readers persist explicit targets plus `locations` and quote context
- pdf persists `page`, `page_progression`, `zoom`, and coarse `position`
- the shipped contract is discriminated by `kind` and rejects removed flat
  locator bags

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
  `?loc` deep link -> saved exact target snapshot -> coarse fallback ->
  first section
- once the section is open, epub restores by exact text offset,
  then quote context, then progression, then coarse publication fallback,
  then anchor fallback
- restore is one-shot and abortable; user scroll cancels any pending
  automatic restore
- web/transcript pick explicit fragment/time targets first and fall back
  to the saved explicit target otherwise
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
- epub delayed-hydration no-snap-back after manual scroll
- epub intra-section locator resume after reload
- pdf page + zoom + intra-page locator resume after reload
- pdf in-session page persistence without file reopen

## validation commands

```bash
make verify
make test-e2e
make test-e2e-ui
```
