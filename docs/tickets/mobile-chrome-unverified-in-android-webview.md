# android gesture-mode bottom insets remain unverified

status: open · origin: 2026-10-10 app navigation reauthor (cleanup/appnav-reauthor) · area: web / mobile chrome, android shell

the 2026-10-13 pane-controls session qualified the physical android webview in
the isolated `app.nexus.android.panecontrols.debug` package. native gestures
proved forward retreat, inert hit testing, reverse reveal, partial retreat
settling, plain-tap reveal, find hold and close release. saved restore remained
shown. configuration rotation from 360×780 to 780×360 and back also showed
chrome; the original portrait lock was restored. real ime reduced the visual
viewport to 360×477 while clear, close, and section navigation remained usable
at 44px with 16px text. the nexus control ended at y720 in the 780px viewport.

evidence: [durable qualification record](../pane-controls-verification.md);
disposable native receipts were removed after qualification. apk sha256 `0fa9d18cac25bf4067703f0770e040e312f23293ff00fde5d5a05c95d90771c7`.
the handset used three-button system navigation. that proves clearance above
its navigation area, but does not qualify gesture-mode safe-area values.

what to do: on an android device already using gesture navigation, open a
reader and its native keyboard; inspect `--viewport-safe-*` and the nexus
control against the actual system gesture area in both orientations.

resolved when: the control clears that area and remains reachable, or a
concrete defect has its own ticket. do not repeat the already qualified motion
journey merely to close this remaining inset check.
