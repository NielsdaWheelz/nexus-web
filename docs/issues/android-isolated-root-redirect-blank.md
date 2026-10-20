# android isolated default entry opens blank

status: open; default startup unqualified, cause unproven
area: android hosted webview / isolated stack

run `20261020-020906-fa069e2d264f`, source
`6020a3245db78c83c74711546988b548167c1899`: the owned debug apk launched without
an intent uri on emulator `5584`, but its webview target remained empty. the
device was awake and unlocked, cellular and wi-fi networks were validated, and
the generated `NEXUS_BASE_URL` matched the current disposable origin. the public
android connector's `.page()` waited indefinitely; installed
`apps/web/node_modules/playwright-core/lib/coreBundle.js:64777` uses no timeout,
and page initialization waits for a noninitial navigation.

one ordinary native `ACTION_VIEW` to the owned `/version` at
`2026-10-20T09:20:04.995893 UTC` unblocked attachment, real password-form login
and public-command fixture creation. the private receipt is
`.nexus-local/lab/20261020-020906-fa069e2d264f/artifacts/manual-native-entry.log`.
this leaves default startup unqualified; no row-drag defect is established.
`apps/android/app/src/main/java/app/nexus/android/MainActivity.kt:375` can restore
webview state and skip default navigation; that is a candidate, not a diagnosis.

earlier evidence from 2026-09-25: an isolated root produced an empty
`about:blank` document, while an owned login deep link worked. its server
redirect unexpectedly used `localhost` despite a configured loopback address.
that observation remains unresolved; a shared cause with this run is unproven.

resolved when fresh and warm launches without an intent uri reach a nonempty
owned login/workspace url, and the public android sdk attaches without a manual
uri. retain validated-network and correct-origin evidence; distinguish restored
state, redirect behavior and connector waiting before choosing a repair.
