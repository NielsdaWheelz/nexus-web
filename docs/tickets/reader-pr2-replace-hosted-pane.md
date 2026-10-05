# reader pr2: replace the hosted media pane with the shared reader core

status: open · origin: 2026-10-04 cleanup campaign (claude coordinator), after pr1 #526 · area: web reader

## what is wrong

the hosted media pane still runs the old reader (`MediaPaneBody.tsx` 7.3k, `PdfReader.tsx` 4.0k, `lib/reader/**`, `components/reader/**`, `lib/highlights/**`; ~35k formatted lines) beside `lib/documentReader`, which pr1 (#526) added for `/s` and the offline shelf. main carries both readers until pr2 lands (pr1 was net +2.7k).

## owner decisions (2026-10-04)

- transcripts render as one continuous text, not a segment list.
- "back to your spot" keeps the first held spot (closes the find-return question as by design).
- two prs; pr2 replaces the hosted pane in one cut, no adapters between old and new halves.
- highlight paint moves to css custom highlights, approved on the condition that a probe proves it. the probe (chromium 147, chrome 154, firefox 157/148, webkit 26.4, android webview 113) returned GO WITH CONDITIONS.

## conditions pr2 must meet (from the probe)

1. paint: per text node, the existing `segmentHighlights` → one `StaticRange` per disjoint segment → `hl-{topmostColor}`; never register a highlight's own overlapping ranges (per-colour sets with priority blend translucent inks: 12/28 overlap cases wrong).
2. `StaticRange` only, for marks, focus, hover, evidence, pulse and find (live ranges tax every dom mutation; see `find-paints-live-ranges.md`).
3. repaint triggers, exhaustive: mark set change; unit dom (re)mount or document version change; a unit entering/leaving the ±1-viewport window. nothing else (resize, font, line height, theme, rotation need none: live == fresh, 0 px).
4. priorities: `hl-{color}` −4, `hl-hover` −3, `hl-evidence`/`hl-focus`/`reader-pulse` −2, colour-only focus dimming −1, `nexus-find-all` 0, `nexus-find-active` 1.
5. css: literal colours in `::highlight` (chromium ≤113 ignores `var()` there); dark inks via a theme-class selector; no border/shadow/outline/filter/animation; pulse as a js toggle; decide print.
6. hit-test: `caretPositionFromPoint(x, y, {shadowRoots})` else `caretRangeFromPoint`, confirmed by grapheme rects on both sides, with a node scan and `elementFromPoint` fallback for bidi; ids topmost-first; never `highlightsFromPoint`.
7. lazy registration of units within ±1 viewport (firefox reflow cost; webkit `content-visibility` units never paint otherwise).
8. shadow-root surfaces (dossiers) carry the `::highlight` rules in their adopted sheet and pass `shadowRoots`.
9. keep `selectionToOffsets` over the untouched dom.

journeys to add (chromium, firefox, webkit; android webview where marked): paint (light/dark, overlap inks), reflow (live == fresh), mutate (text nodes, selection, scroll kept; no loading gate), static ranges (1,000 dom mutations < 5 ms at 2,000 highlights), lazy (webkit content-visibility, firefox ≤ 6 ms/layout), hit (0 errors incl. bidi, emoji, taps), select, find over marks, shadow.

pr2 also fixes the hosted-pane defects ticketed separately: `pdf-open-saves-unread-position`, `pdf-page-buttons-do-not-hold-reading-spot`, `reader-section-nav-stuck-at-article-top`, `transcript-segment-click-does-not-save-position`, `reader-cursor-save-logs-false-network-error`, `reader-jump-saves-position-without-reading`, and the drifted position bucket (1024 in the pane vs 1000 elsewhere).

## prerequisites

none in the repo. the spec, design (`design.md` pr2 section), amendments, the 97-journey reader harness and the full probe report are outside the repo in `/Users/nnandal/Documents/code/nexus-web-campaign-artifacts/2026-10-04/reader/` and `/Users/nnandal/Documents/code/nexus-web-campaign-artifacts/2026-10-04/csshl/report.md`. the primitive's remaining headroom and deferred surfaces: `reader-core-pr2-surface-gaps.md`.

## acceptance

the hosted pane renders on `lib/documentReader`; the old reader files are deleted; the nine conditions hold and the highlight journeys pass on chromium, firefox and webkit; the reader harness is green; `lib/documentReader` stays ≤ 4,200 formatted lines or the owner re-plans.
