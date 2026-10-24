# exact writing-store removal in the installed android app is unqualified

problem: the online-first cutover must retire the release app's writing data
without clearing downloads, catalog, cookies or playback. the signed maintenance mechanism is qualified in an emulator release namespace;
the actual phone inventory, exact-store deletion and retained product state still
need paired-release qualification.

evidence at `4acdadc1d`: `apps/android/app/src/main/java/app/nexus/android/NexusWebView.kt:11`
enables inspection only for `BuildConfig.DEBUG`; the debug build uses a distinct
`.debug` application id (`apps/android/app/build.gradle.kts:162`). its storage
does not prove access to the release app's `nexus-writing:<account_id>` database.
`DeviceSession.kt:459-473` clears substantially more than writing and is unsuitable.

the owner selected a temporary signed maintenance build on 2026-10-23, followed
by the clean final apk. the exact origin/package/signature/version procedure is
in [release-online-first-writing](release-online-first-writing.md); its actual-phone
qualification is still pending. no permanent
legacy decoder/cleanup path and no whole-app reset are authorized by the writing
cutover. implementation can proceed independently; installed cleanup cannot be
claimed until its exact mechanism is qualified.

mechanism observed on 2026-10-23: same `app.nexus.android` package/signature,
seed 26 -> inventory 27 -> exact purge 28 -> verifier 29 -> clean canonical app 30.
only the named synthetic writing database was removed; unrelated indexeddb,
localstorage, a persistent cookie and a native file survived. the phone stayed at
release 26. this does not prove catalog/download/player state or its actual purge.

resolved when actual-phone scoped removal and preservation of unrelated product
state are observed through the paired release procedure.
