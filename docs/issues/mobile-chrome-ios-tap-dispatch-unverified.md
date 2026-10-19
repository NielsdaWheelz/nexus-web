# reader tap reveal is unverified on real ios webkit

status: open · origin: 2026-10-10 app navigation reauthor (cleanup/appnav-reauthor) · area: web / mobile chrome

tap reveal (`apps/web/src/lib/mobileShell/chrome.tsx`, `registerReaderScrollport`)
listens for `click` on the reader scrollport itself and decides in a 0ms timeout
after the dispatch. the listener on the element is what keeps ios webkit
dispatching taps on plain text (it skips click synthesis on non-clickable
content otherwise). playwright's webkit passes M5.tap-reveal and
J7.tap-reader-reveals, but that is desktop webkit with emulated touch, not ios
safari or a wkwebview; real ios tap dispatch was not available here.

what to do: on an iphone (safari, or the hosted app in a wkwebview), retreat the
chrome in a long article and tap blank paragraph text; then tap mid-retreat.

resolved when: both taps bring the chrome back on a real ios device, or the
failure is diagnosed (e.g. a `cursor: pointer` or touch listener needed on the
scrollport) and fixed.
