# the mobile keyboard inset has no browser proof

status: open · origin: 2026-10-10 app navigation reauthor (cleanup/appnav-reauthor) · area: web / mobile viewport

`useKeyboardReport` (`apps/web/src/lib/ui/useKeyboardInset.ts`) reports an
open sheet's or task's keyboard inset to
`MobileViewport.reportMobileOverlayKeyboardInset` (`apps/web/src/lib/mobileShell/viewport.tsx`),
a token stack whose newest report becomes `--mobile-overlay-keyboard-inset` and
joins `--mobile-content-bottom-clearance`. playwright cannot raise a soft
keyboard (no visual-viewport shrink), so no harness journey exercises a nonzero
report, its stacking (two sheets) or its release; the reports arrive as 0.

what to do: on a handset (android webview, ios safari), open a sheet with a text
field (library picker search, link editor), raise the keyboard and confirm the
sheet's terminal content clears it; open a second sheet over it, close it, and
confirm the first sheet's clearance returns.

resolved when: those observations are recorded here, or a browser harness gains
a way to shrink the visual viewport and a journey pins the stack.
