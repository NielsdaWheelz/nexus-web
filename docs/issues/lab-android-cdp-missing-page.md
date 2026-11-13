# android lab cdp attaches without an application page

run `20261112-182104-41f4ddd80a09`, based on `a36bf6d9a`, passed the
owned webview target check and cdp connection, but exposed one browser context
with no page. `apps/web/scripts/lab/android.ts:118` then failed:
`browserContext.waitForEvent: Timeout 20000ms exceeded while waiting for event "page"`.
the canonical playwright runner used node 22.23.2 and the owned windowless
`nexus-api34`. sign-in and the companion journey were not reached. the cause is
unconfirmed; this is a different observed stage from the websocket timeout.

private evidence: the run's `artifacts/android-results.json`,
`android-failure-native.json` and `android-release.json`. cleanup reported no
errors: the package stopped, owned forward/reverses were released, the debug
package was uninstalled and the owned emulator exited.

run `20261112-182753-f9cb79757410` observed the enabled native sign-in control
before its single attachment and attached successfully. that observation does
not establish the earlier missing-page cause or prove it repaired.

reproduce with the canonical paired debug apk and `openLabAndroid`; preserve
target/version responses and native process state before cleanup. resolved when
the missing page's lifecycle cause is repaired and bounded attachment reaches the
real native journey at the same scope. do not substitute a retry loop or a
different attachment path for that evidence.

run `20261112-192443-257fcc546716` qualified the installed companion journey; this does not prove the earlier cause resolved.
