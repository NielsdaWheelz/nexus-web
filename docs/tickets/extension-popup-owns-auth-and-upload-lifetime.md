# extension popup owns work that must survive dismissal

status: open · origin: 2026-09-23 firefox v1 review · area: extension lifecycle

`apps/extension/manifest.json:12-29` declares a popup but no background owner.
`popup.js:135-155,209-248,283-293` owns authentication, file download and capture
submission inside that popup. firefox unloads a dismissed popup. login changes
focus; ordinary dismissal can interrupt work or lose its result. this is a
source-confirmed lifetime hazard, not a recorded live failure.

evidence: [mozilla popup lifecycle](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/user_interface/Popups).

fix: use a firefox background event page for auth/submission ownership and a
small stored operation record for the original tab, operation identity and
receipt. define interruption/recovery explicitly; do not equate an event page
with durable storage or claim an unfinished upload is saved.

acceptance: closing/reopening the popup during login and submission preserves
the original source and reveals the actual outcome; an interrupted transfer
offers an honest retry without duplicate acceptance.
