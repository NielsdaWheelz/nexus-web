# map rail ticks ignore the highlight's colour

source finding on 2026-11-12; not rendered. every highlight tick is yellow:
`apps/web/src/lib/documentReader/chrome/MapRail.tsx` sets `data-tone` to highlight
or warning, and `chrome.module.css:102–104` paints highlight ticks with
`--highlight-yellow`. the marker carries no highlight colour.

impact: a green, blue, pink or purple highlight gets a yellow map tick.

resolved when a tick uses its highlight's colour. the dark-reader ink mismatch
is separate: [highlight swatches](highlight-swatches-ignore-dark-reader-inks.md).
