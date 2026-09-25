# android back from the downloaded reader shows "Not found"

status: open; pre-existing · origin: 2026-09-24 reader-inspector-controls live verification, branch `reader-inspector-controls` · area: android offline reading

with the offline shell active, system back from the downloaded reader/shelf
calls `webView.goBack()` to the hosted history entry. that main-frame request is
neither `OFFLINE_READING_MAIN_URL` nor `requestedHostedMainFrameUrl`, so
`shouldInterceptRequest` routes it to
`OfflineReadingRequestRouter.interceptOfflineDocument`, which answers 404
(`OfflineReadingRequestRouter.kt:226`). the user sees an unstyled `Not found`
page instead of the "Leave downloaded reading?" confirmation. observed on a
samsung SM-S906W (android 16, webview 151) with a debug build.
where: `MainActivity.kt` back callback (~492) and `shouldInterceptRequest` (~330).

fix: back out of the offline shell goes through the leave confirmation and
returns to the hosted origin by the owned navigation path.

acceptance: on a handset, back from a downloaded reader shows the confirmation
and then the hosted page.
