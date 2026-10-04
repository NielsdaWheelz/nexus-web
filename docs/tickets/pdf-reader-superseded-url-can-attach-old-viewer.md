# superseded pdf url can attach an old viewer

status: deferred · origin: 2026-10-04 source audit · area: pdf reader / web

`apps/web/src/components/PdfReader.tsx:3219–3224` sets the old signed-url effect's `active` flag false on cleanup, but does not change `runRef`. `initializeViewerIfNeeded` awaits the viewer import and then checks only the run id (`:2074–2077`); `attachDocumentToViewer` does the same (`:2378–2380`). after a same-media url replacement during that await, the superseded open can still attach or publish the old viewer. this is a source-qualified temporal risk, not an observed failure.

hold actual viewer-module resolution for one open, supersede its signed url in the same media mount, then release it. only the current open may bind or publish; the old task must close once. preserve pending-open and partial-viewer cleanup.
