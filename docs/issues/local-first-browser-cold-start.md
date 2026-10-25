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
