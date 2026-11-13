# fresh android lab launch lost its application process

run `20261112-191210-5cd772c32ad9` created a unique private pixel_6 avd from
the installed api34 google_apis arm64 image. the paired debug apk installed,
cleared and launched through `openLabAndroid`, but the owned resumed-webview
observation failed after 30 seconds. the failure image shows the unlocked launcher;
`pidof app.nexus.android.debug` returned no process and the crash buffer was empty.
the webview provider reported ready, with relro 1/1 and no dirty package.

private evidence: `artifacts/android-failure.png`, `android-failure-native.json`,
`android-results.json` and `android-apk-pairing.json`. source base: `a36bf6d9a`.
package/mapping cleanup completed and `android-avd-release.json` confirms deletion
of only this run's avd. the companion journey was not reached.

the cause is unconfirmed. the initial diagnostics only retained full logcat for a
still-live pid, so they missed evidence across process death. capture the package's
ActivityManager exit-info and the owned disposable device's system/events logs
before teardown, retaining launch and observation times. resolved when the exact
exit owner is identified and repaired and the fresh native journey completes.
this does not establish the separate retained-task or physical framework-crash causes.

run `20261112-192443-257fcc546716` qualified the installed companion journey; this does not prove the earlier cause resolved.
