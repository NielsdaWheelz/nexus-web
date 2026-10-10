# mobile chrome is unverified inside the android webview

status: open · origin: 2026-10-10 app navigation reauthor (cleanup/appnav-reauthor) · area: web / mobile chrome, android shell

the rewritten mobile chrome (`apps/web/src/lib/mobileShell/chrome.tsx`) and
bottom geometry (`lib/mobileShell/viewport.tsx`) were verified only in
playwright-managed chromium and webkit at 390x844 (touch, dpr 3): the c2nv nav
harness, J5-J10, D2 and M1-M12 on both engines. no handset was available, so
the android webview was not exercised: chrome retreat and tap reveal inside the
shell, `inert` as the only hit-test gate on the shell's chromium, the
module-written `--mobile-chrome-collapse` under real momentum scroll, and real
safe-area insets feeding `--viewport-safe-*` and the Nexus offset.

what to do: on a handset with the debug app over `adb reverse` against a local
stack (reference_isolated_live_stack recipe), read the long article: scroll down
(chrome retreats, the top bar is not tappable), scroll up past 8px (it returns),
fling and stop mid-retreat (it settles to an end, never frozen), tap blank text
while hidden or moving (it returns), open More and Find (it stays shown), rotate
(it resets shown). check the Nexus control rests above the gesture bar.

resolved when: that session's observations are recorded here and match, or a
defect found there has its own ticket.
