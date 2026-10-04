# android loses the session if the app is killed right after login

status: open · origin: 2026-10-04 offline reauthoring harness (defect 6b), branch `cleanup/offline-reauthor` · area: android shell / auth

signing in and then force-stopping the app before it is backgrounded comes
back signed out. the offline harness works around it: `stopApp` in its
`lib.mjs` presses home and waits 1.5 s before `am force-stop` "as a user
leaving it; it persists cookies on pause". `MainActivity` flushes
`CookieManager` only in `onPageFinished` and `onPause`. afaict the session
cookies written after the last main-frame `onPageFinished` (client-side
navigation or fetches that rotate the supabase cookies) sit in the webview's
memory until the next pause, so a kill in between drops them. idk which login
step writes the cookie that is lost; that is the first thing to establish.

impact: low. a user who swipes the app away seconds after login must sign in
again. offline is unaffected except that its `me()` check then reports
authorization required.

prerequisite: reproduce on the emulator: clear app, sign in through `/login`,
`am force-stop` within 1 s of landing on `/lectern`, relaunch; record which
`sb-*` cookies are missing.

fix: flush at the responsible boundary, i.e. after the login handoff settles
(or whenever the bff rotates the session), not by adding timers.

acceptance: the reproduction above stays signed in on relaunch; the harness
`stopApp` no longer needs the home-and-wait step.
