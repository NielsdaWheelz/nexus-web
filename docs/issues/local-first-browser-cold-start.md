# offline cold entry and authored route admission

browser offline delivery now uses the same packaged shell, complete public-asset
cache and confirmed local account as the installed app. full stock firefox cold
qualification remains in progress; neither a storage-only proof nor a successful
online bootstrap proves it.

actual native red: frozen `45d0c2a33`, samsung sm-s906w/android16/webview155,
`20261025-140059-78a603a67aaf/artifacts/native-localfirst`. after real password
handoff and completed local provisioning, remove the owned adb reverse mapping,
force-stop the qa package, wait its pid to disappear and cold-launch
`/pages/new`. the shell shows “this view needs a connection”; no page editor
mounts. stopping the process is necessary because existing http2 tunnels can
survive reverse-listener removal.

cause: `WorkspaceHost.tsx`'s cold-body predicate omitted `pageNew`, `dailyDate`
and `search`, despite their local data owners. the implementation now classifies
all six authored pane routes as local; `/daily` resolves to `dailyDate` before
pane admission. share capture has its own canonical entry and provider.

resolve after the sole static gate and a fresh frozen handset/browser cold run
prove local new-page/daily/search admission, offline create/edit, process kill,
reopen and reconnect, with actual denied transport and server-absence checks.

lab54 on b1 (`20261025-212216-4c293cc5ee65`) reached canonical reader
captures, then its first full-document offline navigation to search remained at
“preparing your notes” through a ten-second query-status wait. the new authored
worker script request was unfinished in the retained trace. this establishes a
setup observation, not permanent failure or an fts result. the context-index
case now mounts search online, then uses its real input and kind operators
offline to isolate the intended index behavior. stock firefox cold proof is a
separate target qualification and cannot be inferred from this chromium run.
