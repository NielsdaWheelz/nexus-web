status: open
origin: 2026-09-12, reader document map offline artifact build
area: web build tooling

`bun run build:offline-reading` succeeds but lightningcss emits five warnings:
`'highlight' is not recognized as a valid pseudo-element` for the existing
custom-highlight selectors in
`apps/web/src/components/reader/textDocumentReader.module.css:165-185`.
the output recommends the incorrect replacement `:highlight`.

prerequisite: identify which pinned parser/minifier emits the warning and inspect
its generated selector. correct the build tool's handling of `::highlight(...)`;
do not replace the browser api syntax or suppress unexplained warnings.

acceptance: the offline production build preserves custom highlight and
forced-colors selectors without warnings; find highlighting still renders in
the supported chromium/webview runtime.
