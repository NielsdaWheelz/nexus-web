# reader scroll indicators need application verification

status: open
origin: 2026-10-12 architectural audit; pr #565
area: reader / android acceptance

the current shared reader and styles passed browser fixtures and native gestures
on android 15 (api 35), webview `124.0.6367.219`. that android run used a historical
debug apk as the webview carrier. it did not exercise the complete hosted or
downloaded application, or rebuild the current apk. the final contrast outline
and inactive-axis suppression have browser proof, not a fresh native run.

evidence: pr #565 validation receipts; `DocumentReader.tsx`, `scrollport.ts` and
`documentReader.module.css` own the shared behavior; hosted media chrome and
`shelf/ShelfReader.tsx` supply different surrounding layouts.

impact: reader-component correctness is qualified; final application integration
and the user's installed artifact remain unverified. do not claim production
or installed-device acceptance from the isolated fixture.

prerequisites: a served web artifact and packaged shelf built from the final pr
head, with their source/build identities recorded.

acceptance: open real articles and epubs through both application journeys on
android; in portrait and landscape, verify no scrollbar gutter, indicators
during drag and momentum, idle disappearance, native selection, and section
jump/return. verify a zoomed pdf can pan in both axes. record device, webview,
artifact identity and observations, accounting for the separate layout tickets.
