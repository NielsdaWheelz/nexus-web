# landscape keyboard lets the pinned header cover pane controls

status: open
origin: 2026-10-16 find-bar physical phone verification; build `d03fc1ff3`
area: web / mobile chrome, viewport

on `SM_S906W`, chrome `155.0.8059.79`, the inherited landscape settings were
`accelerometer_rotation=0`, `user_rotation=1`. menu, find and return succeeded;
return refocused the field and opened the real ime. an ordinary options tap
was intercepted by the pinned appnav more control. a second attempt could not
tap the find field because the pinned appnav title intercepted it. no events
were forced. the controls became unreachable while the keyboard was open.

receipt: `/tmp/nexus-find-bar-20261016/phone-attempt2.log` recorded
`locator.tap: Timeout 10000ms exceeded` for the `Find in conversation` searchbox;
the intercepting header had `data-mobile-chrome-phase="Pinned"` and its `h1`
intercepted repeated retries. the first options failure is an operator observation.
the disposable logs were deleted after recording this evidence.
this run did not measure viewport height. the final portrait journey in foreground
chrome passed ordinary find, return, native back, options, whole word and close.

the fixed header owner was `apps/web/src/components/appnav/AppNav.module.css:331`
at that build; since the pane chrome re-slice it is `.mobile` in
`apps/web/src/components/ui/SurfaceHeader.module.css` (the pane header's Mobile
projection, rendered inside the pane's section). pane controls sat below it at
`apps/web/src/components/workspace/PaneShell.module.css:195`. those owners and
`apps/web/src/lib/mobileShell/` were unchanged from baseline `69c00182c` to that
build. the failing landscape journey was not replayed on the baseline, so
the precise cause remains unestablished. the existing [landscape cutoff
ticket](phone-landscape-exceeds-mobile-layout-cutoff.md) describes a different failure.

prerequisite: an authorized handset session. reproduce the landscape find/return
journey with the real ime; inspect visual viewport, scroll and header/control
geometry together. fix the responsible mobile chrome or viewport owner.

acceptance: ordinary taps reach find, return, options and close in portrait and
landscape with the real ime open, without forced events or header interception.
record the served build, device, browser and viewport measurements.
