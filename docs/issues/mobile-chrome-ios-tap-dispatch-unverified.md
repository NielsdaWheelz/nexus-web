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

the persistent-player cutover also requires the idle, loaded and unavailable
footer to follow those trusted taps without moving its normal-flow slot.
`GlobalPlayerSurfaces.tsx` joins `useMobileChromeSurface`; the gesture owner is
now `lib/mobileShell/readerTap.ts`. browser webkit cannot prove ios dispatch.
the owner confirmed no ios device is available for this qualification run
(2026-10-21); the player portion remains `NOT_RUN` until the same journey is
observed on hardware.
