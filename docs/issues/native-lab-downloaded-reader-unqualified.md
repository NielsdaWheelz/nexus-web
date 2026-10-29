# downloaded reader parity lacks completed native download proof

problem: the disposable android journey has not reached a completed reading-copy
download, so offline generic contents navigation remains unqualified.

evidence: integrated `7b062d659`, lab `20261028-193108-0f54391729dd`, owned
android 15 emulator 5640, webview 124. the actual download action and text-only
confirmation succeeded; after ordinary downloads navigation the row stayed
`queued · retrying after interruption`, 0 bytes, through a 60-second readiness
deadline. the package was not force-stopped during that attempt. api logs contain
no reading-copy request. native companion entry, real keyboard dismissal, nested
back/task back and contents destination checks passed before this gap.

cause is unestablished. `OfflineJobService.kt:168` binds its client to the job's
android network; that network may not reach adb reverse on loopback. its transfer
drain converts an io failure to a retry without retaining the cause, and scoped
`NexusDownloads` logcat was empty. do not bypass network policy or fabricate a
cached copy to complete this proof.

resolved when an actual owned-package download reaches ready, survives an app
restart, and opens offline through `read downloaded copy`; its generic contents
must reveal the exact requested source passage. record the supported provider,
application source and apk identity. this remains a release qualification gap.
