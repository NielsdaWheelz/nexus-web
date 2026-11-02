# popup ships unreachable route glyphs

problem: the extension popup's bundle carries every route and scheme drawing, though it
renders none. `lib/panes/paneRouteModel.ts` builds two tables at module scope: `ROUTES`,
whose entries hold lucide drawings directly and through `resourceIconForScheme` calls
(`:50-78`) that read `SCHEMES` (`lib/resourceGraph/resourceRef.ts:33`), and `TABLE`
(`Object.keys(ROUTES).map`, `:196`). the bundler keeps both as side effects whenever
anything in the popup closure imports the module, though the popup uses none of its
exports. `apps/web/package.json` declares no `sideEffects`.

impact: dead weight in the popup chunk. every drawing in `ROUTES` or `SCHEMES` ships,
including `Scroll`, which in that closure only `xCapture` uses (`paneRouteModel.ts:54`).
media kind drawings stay out: `lib/media/kind.ts` and `lib/resources/type.ts` are
outside the closure.

evidence: paths under `apps/web/src`. six popup-closure modules import the route model:
`lib/panes/paneRuntime.tsx:16`, `lib/recent/model.ts:3`, `lib/resources/sourceTarget.ts:6`,
`lib/workspace/model.ts:8`, `lib/workspace/store.tsx:24`,
`lib/workspace/targetActivation.ts:3`. the popup chunk built by
`apps/web/scripts/build-extension.mjs` keeps the `ROUTES` literal and `TABLE` as a bare
`Object.keys(...).map(` statement whose result is discarded, while the code those imports
name is gone: `Year in Reading` (`resolvePaneRouteModel`), `invalid recent snapshot`
(`lib/recent/model.ts`) and `recent_open` (`lib/native/client.ts`) are absent. the
closure's own components import ten drawings (`components/feedback/Feedback.tsx:3`,
`components/libraries/LibraryChooser.tsx:4`, `components/libraries/DestinationChooser.tsx:4`,
`components/ui/ChoicePicker.tsx:4`, `components/ui/PickerSurface.tsx:12`,
`components/ui/MobileSheet.tsx:5`). the chunk defines 38; the other 28 are route and
scheme drawings, among them `scroll`, bound to `x/captures/:id`, and `file-text`. it
defines no `book-open`, `audio-lines` or `video`.

proposed fix: build the route table without module-scope calls, or move the drawings
into a module no popup-closure module imports. removing recents' import alone changes
nothing: five other importers keep the module and its tables. moving `SCHEMES` alone
gains nothing while `ROUTES` keeps its drawings.
an icon registry does not fix this: the tables hold references either way.

resolved when the built popup chunk defines only the drawings the popup renders.
