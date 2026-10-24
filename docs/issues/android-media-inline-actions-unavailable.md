# android media inline actions unavailable

on api 35 with `com.google.android.webview` `124.0.6367.219`, the canonical
debug apk reaches a seeded podcast episode through an owned view intent, but
its inline resource actions, including play, remain absent after 30 seconds.
the title renders; the body says `preparing transcript` and
`some open content couldn’t refresh.` the player correctly reports
`nothing queued`. this blocks the inline playback path; the lazy resource menu
was not inspected in this observation. later run
`20261023-185558-b86f840104e1` confirmed that its enabled play action starts
actual native audio: the seek position advances, pause succeeds, and the
durable queue retains the selected occurrence. root cause of the missing
inline actions is unknown.

evidence: disposable run `20261023-184808-c529df02e2c6`, media
`388d8d51-ca9f-44c8-90ed-244cf4a5f64a`. private artifacts
`native-media-state.json` and `native-platform.png` show the settled route,
buttons and real native screen. the foreground window is the app, with no
system error dialog. `api.log:50` records `GET /media/<id>` 200; line 54 records
`POST /media/summaries/resolve` 200. these statuses do not establish that the
renderer accepted or presented their contents.

reproduce: build the current debug apk for a disposable origin; sign in through
the real password handoff; seed a playable episode in that account; send its
owned media view intent and inspect the header. related evidence lives in
[android-webview-workspace-readiness-stall.md](android-webview-workspace-readiness-stall.md),
without an established common cause.

resolved when the same actual-host journey reliably presents its inline play
action and starts native audio, with the refresh warning explained or repaired.
