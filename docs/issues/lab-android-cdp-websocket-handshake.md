# android lab websocket attachment timed out

one bun-driven api34 run, `20261112-124150-69e671bbb2dd` at `a3d489a0f`,
failed before sign-in at `apps/web/scripts/lab/android.ts:115`.
`connectOverCDP` read `/json/version`, then timed out after 20 seconds connecting
to `ws://127.0.0.1:65392/devtools/browser`. native foreground/webview observation
and the helper's owned-page admission had passed. the cause is unresolved.

the existing node 22.23.2 playwright runner subsequently attached successfully.
run `20261112-130414-4ea4a11c9d91` at `5832e33f0` completed real sign-in and
reader keyboard, chrome, clearing, closing and passage checks. all owned resources
were removed. no reader defect is established; the successful node runs alone do
not establish bun as the earlier failure's cause.

evidence: the failed run's private `artifacts/reader-find-android/failure.txt`
and `emulator.log` under `/private/tmp/nexus-reader-find-native/.nexus-local/lab/`.
reproduce with the canonical paired debug apk, owned windowless `nexus-api34` and
`openLabAndroid`; capture runtime versions, owned pid, adb state, target/version
responses and guest crash logs before cleanup. resolved when the failed websocket
owner is identified and repaired, with successful attachment at the same scope.
