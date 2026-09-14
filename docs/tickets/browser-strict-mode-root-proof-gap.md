status: open
origin: 2026-09-14, account-cache replay investigation
area: browser proof / effect retirement

`apps/web/vitest.browser-setup.ts:49` wraps every testing-library render in
`RenderEnvironmentProvider`. jsx `StrictMode` therefore sits below that root.
react explicitly omits initial effect replay in that composition; account proof
`8237129153840039` did not exercise its claimed replay. the installed
`@testing-library/react/dist/pure.js:123,193` exposes `reactStrictMode: true`,
which places strict mode outside the fixture wrapper.

use that existing render option in proofs claiming initial replay; remove their
redundant nested wrappers. affected owners: `resourceCacheAccount`, `useReaderTarget`,
`OfflineReadingShelf`, `PodcastDetailPaneBody.episodesView`, `HtmlRenderer` browser
proofs. preserve every behavioral oracle and replay changed canonical owners.
do not enable it globally or introduce a custom react lifecycle harness.

acceptance: named replay cases run at the actual strict root and retain their
behavioral guarantees under `./scripts/test`; refresh pins only after review
and sensitivity where required.

source: [react strict mode](https://react.dev/reference/react/StrictMode#enabling-strict-mode-for-a-part-of-the-app).
