# the shipped css highlight paint is unverified in the android webview

status: open · origin: 2026-10-05 reader rewrite pr2 · area: web reader / android

the probe (`csshl/report.md`, 2026-10-04) verified css custom highlights on an
api 34 emulator webview 113 with its own probe page: literal colours paint,
touch hit-testing has 0 errors. the shipped reader (`lib/documentReader/text/paint.ts`)
ran its `R.HL.*` journeys only in playwright chromium, firefox and webkit. the
hosted pane in the android app and the offline shelf were not driven.

to do (by hand, a debuggable build on the emulator and a current phone): open a
highlighted article and book, check light and dark inks and overlaps, tap a mark
(menu) and an overlap (chooser), select text near emoji and rtl text, and run
find over marks.

done when: the checks are recorded as passing, or the defects are ticketed.
