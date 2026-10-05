# find paints live dom ranges and uses var() inside ::highlight

status: open, to be fixed by the reader pr2 (css highlight conditions) · origin: 2026-10-04 css highlight probe (scratchpad csshl/report.md, F2 and F5) · area: lib/find, app/globals.css

## what is wrong

- `lib/find/find.ts` `highlightPainter` registers live `Range`s (up to 2,000). every live range is updated on every dom insert/remove anywhere in the document: 0.26–0.8 ms per mutation in chromium at ~4k ranges vs ~1 µs without, while find is open.
- `app/globals.css` styles `::highlight(nexus-find-all)` with `var()`. chromium/android webview ≤113 ignores custom properties inside highlight pseudos, so find-all paints nothing there (literal colours paint).

## fix

register `StaticRange`s (keep no live ranges); use literal colours (dark variants via a theme-class selector).

## acceptance

with find open over 2,000 matches, 1,000 dom insert/removes take < 5 ms; find-all paints on android webview 113.
