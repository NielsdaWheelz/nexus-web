# largest-corpus opening and memory remain unqualified

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

2026-10-19 hosted-phone qualification uses *shadow & claw*: 79 units and
1,062,227 canonical characters. native tracing identified duplicate geometry
capture, unchanged reflow chasing inertia and first-use nfc provenance work;
the mobile chrome change removes redundant capture/correction and reuses
unchanged canonical spans. `TextSurface.tsx` still estimates skipped heights
from configured column width while the actual column can shrink to the phone
viewport. the largest corpus book, public reader and shelf remain unmeasured;
this hosted case does not close that broader gate.

to do: open the largest corpus epub (hosted after pr2; public `/s` and the
shelf now) on desktop and on the phone; record time-to-first-text, long tasks
over 50ms during open and the first scroll, and memory. attribute any failure;
consider windowing only if mounted dom, startup or memory is responsible.

done when: opening, first traversal and memory meet an explicit device budget
for the largest book in each host. record measurements and limits in the
closing pr; fix the attributed cause before closing.
