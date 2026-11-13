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

reference-quotes run `20261112-222846-5b61b0692b3f` at `87e83a8ac`
reproduced the same bun websocket timeout after owned-page readiness. the
canonical mise node 22.23.2 playwright runner attached in
`20261112-223506-daae3f6a5d38`. run
`20261112-224318-2ebe110218f2` then passed real password handoff, session readiness,
rich selection draft/send, saved words after republication and stale-selection
refusal in the owned webview. this adds a reproduction and a qualified
runner; it does not identify bun as the cause or close the transport defect.
all recorded owned package/mapping/emulator teardown completed.

librarian leaves at `d964629d5` reproduced the timeout after owned-page
readiness in `20261113-004253-56356fb761b3`. the same temporary driver and
canonical helpers under node 22.23.2 passed native sign-in and leaves l1/l3/l5
in `20261113-010603-36b8a3c64043`. all owned resources were retired. this adds
another reproduction and qualified runner without establishing the cause.
