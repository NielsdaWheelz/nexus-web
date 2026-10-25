# highlight swatches ignore dark reader inks

problem: a dark reader paints highlights with its own literals
(`apps/web/src/lib/documentReader/documentReader.module.css:285-299`), while every
other highlight colour reads `--highlight-*`, which `globals.css:120-124` defines
once and equal to the light literals (`documentReader.module.css:270-284`).
readers: picker swatches (`app/(authenticated)/media/[id]/HighlightColourPicker.tsx:35,64`),
map rail ticks (`lib/documentReader/chrome/chrome.module.css:74`) and exact
passages (`components/resources/ResourceContent.module.css:28-40`).

impact: in a dark reader the swatch, tick and passage colours differ from the
marks on the page. found by code reading; not rendered.

proposed fix: one source per reader theme for highlight inks, consumed by the
`::highlight` literals and every reader-adjacent surface. `::highlight` cannot
read `var()` on chromium and android webview ≤ 113 (`docs/modules/visual-system.md:36-37`),
so the literals stay; the tokens must match them per theme.

resolved when, in a dark reader, each swatch, rail tick and passage matches its
painted mark.
