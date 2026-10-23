# fresh page route is unavailable

an authenticated browser with a newly minted device identity opens `/pages/new`
as “this page is no longer available”; no editor appears. direct new-page
creation is blocked. the route remains advertised as `pageNew` in
`apps/web/src/lib/panes/paneRouteModel.ts:58`; creation belongs to
`apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.tsx:35-64`.

observed against `f0748d2b7` plus the popup-sizing change in disposable run
`20261023-150556-5e8624497180`; the reference case cleared only `nx_device`
before navigating. private artifact: `fresh-device-page-new-unavailable.png`.
the parameter/route handoff is a hypothesis, not an established cause.

resolve when direct `/pages/new` entry on a fresh authenticated device exposes
an editable new page, whose first write publishes the intended page and note.
separate from popup geometry; existing-page reference entry can qualify sizing.
