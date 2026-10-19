# whole-document mount is unmeasured on a large book and on the phone

status: open · origin: 2026-10-04 reader rewrite pr1 (`cleanup/reader-reauthor`, shared reader core) · area: web reader (`lib/documentReader`), public `/s`, offline shelf

the shared reader mounts every unit of a text publication in one scroll
(`lib/documentReader/text/TextSurface.tsx`), with `content-visibility: auto`
per unit at an estimated height (font size × line height / column width per
codepoint). the design gates this (risk r1) on time-to-text and long tasks for
the largest corpus book, on desktop and on the physical phone. pr1 verified
only the harness fixtures (a three-chapter epub, a 15-page pdf, a 105-block
article) on desktop chromium and a 390px mobile profile; no large book was
measured, and the shelf was not run in the android webview. the one number
pr1 has (public share of the largest fixture book, 4 units / 13k codepoints,
`next dev` bundles): desktop chromium 379 ms to the marked text with one 105 ms
long task; a 390px profile at 4x cpu throttle 1,001 ms, long tasks 491 and
93 ms.

risk: a book with thousands of units (the corpus has 7–10 mb document maps)
may parse slowly, hold too much dom on the phone, or jump when scrolling up
into never-rendered units (r2, desktop safari).

to do: open the largest corpus epub (hosted after pr2; public `/s` and the
shelf now) on desktop and on the phone; record time-to-first-text, long tasks
over 50ms during open and the first scroll, and memory. if it fails, slot
windowed mounting behind `TextGeometry` (positions are already
`(unit, offset)`).

done when: the numbers are recorded in this ticket's place in the reader module
doc and are acceptable, or windowing lands.
