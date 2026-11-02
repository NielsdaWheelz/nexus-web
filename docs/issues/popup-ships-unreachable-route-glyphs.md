# the extension popup carries glyphs it may never paint

problem: the popup bundle carries 34 drawings. `src/extension/popup.tsx` draws none
itself; they arrive through Feedback, DestinationChooser, LibraryChooser, ChoicePicker,
Button and the route and scheme tables (`paneRouteModel.ts`, `resourceRef.ts`) that
those import. which of the 34 the popup can paint is not traced.

evidence: `bun run build:extension`, drawings counted by `createLucideIcon` name in
`apps/extension/dist/assets/popup-*.js`. before the glyph lexicon (`b09a270e5`): js
430403 bytes (gzip 131733), 37 drawings. after: js 429660 bytes (gzip 131626), 34
drawings, among them `nexus-lectern`, `podcast` and `scroll` from the route and scheme
tables.

impact: bundle weight only. nothing misdraws.

resolved when the popup's reachable glyphs are traced and its bundle holds only those.
