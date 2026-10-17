# verify shared feedback in the installed extension

status: open; installed-extension verification pending
origin: 2026-10-16 compact feedback cutover
area: browser extension / popup

`apps/web/src/extension/popup.tsx` now uses shared status, notice and field
primitives. the extension builds and its command contract is unchanged; this
campaign did not execute the installed popup or a real browser permission prompt.

prerequisite: an isolated installed build with its normal authenticated host.
exercise capture reading/uploading/accepted states, an admitted retry and an
actual permission refusal. use real requests and native permission controls.

acceptance: correct stage copy, usable compact feedback, exact supported retry,
no false completion and no replacement of the browser's permission interface.
