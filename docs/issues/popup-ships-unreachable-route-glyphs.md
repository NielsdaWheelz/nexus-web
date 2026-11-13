# popup ships unreachable route glyphs

problem: the extension popup's bundle carries every route and scheme sign, though it
renders none. `lib/panes/paneRouteModel.ts` builds two tables at module scope: `ROUTES`,
whose entries hold signs directly and through `resourceIconForScheme` calls
(`:24-57`) that read `SCHEMES` (`lib/resourceGraph/resourceRef.ts:18`), and `TABLE`
(`Object.keys(ROUTES).map`, `:174`). the bundler keeps both as side effects whenever
anything in the popup closure imports the module, though the popup uses none of its
exports. `apps/web/package.json` declares no `sideEffects`.

impact: dead weight in the popup chunk. nothing misdraws. every drawing behind `ROUTES`
or `SCHEMES` ships, including `Scroll`, which in that closure only `xCapture`'s `WebText`
uses (`paneRouteModel.ts:32`). media kind signs stay out: `lib/media/kind.ts` and
`lib/resources/type.ts` are outside the closure.

evidence: paths under `apps/web/src`. six popup-closure modules import the route model:
`lib/panes/paneRuntime.tsx:16`, `lib/recent/model.ts:3`, `lib/resources/sourceTarget.ts:6`,
`lib/workspace/model.ts:8`, `lib/workspace/store.tsx:24`,
`lib/workspace/targetActivation.ts:3`. the popup chunk built by
`apps/web/scripts/build-extension.mjs` keeps the `ROUTES` literal and `TABLE` as a bare
`Object.keys(...).map(` statement whose result is discarded, while the code those imports
name is gone: `Year in Reading` (`resolvePaneRouteModel`), `invalid recent snapshot`
(`lib/recent/model.ts`) and `recent_open` (`lib/native/client.ts`) are absent. the
closure's own components name eight signs through `lib/ui/icons.tsx`
(`components/feedback/Feedback.tsx:3`, `components/libraries/LibraryChooser.tsx:4`,
`components/libraries/DestinationChooser.tsx:4`, `components/chat/GenerationPicker.tsx`,
`components/ui/PickerSurface.tsx:12`, `components/ui/MobileSheet.tsx:5`). drawings
counted by `createLucideIcon` name in `apps/extension/dist/assets/popup-*.js`: 38 at
main `02090f957` before the glyph lexicon (js 430629 bytes, gzip 131811); 34 with it
merged (js 429829, gzip 131675), the other 26 route and scheme drawings only, among
them `scroll`, `file-text` and `nexus-lectern`. it defines no `book-open`,
`audio-lines` or `video`.

proposed fix: build the route table without module-scope calls, or move the signs
into a module no popup-closure module imports. removing recents' import alone changes
nothing: five other importers keep the module and its tables. moving `SCHEMES` alone
gains nothing while `ROUTES` keeps its signs. the icon registry did not fix this: the
tables hold references either way.

resolved when the built popup chunk defines only the drawings the popup renders.
