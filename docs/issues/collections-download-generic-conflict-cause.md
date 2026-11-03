# native download conflict claims the original changed

source: frozen `3643a20b466b135e17b5e5c196a00b030df872e2`.

problem and impact: native download conflict claims the original changed. the user receives an unsupported cause.

evidence: apps/web/src/app/(authenticated)/downloads/DownloadsPaneBody.tsx:30 maps Changed to `the original changed`. apps/android/app/src/main/java/app/nexus/android/offline/Transfers.kt:250 and OfflineJobService.kt:300 map ANY HTTP409 to Changed; python/nexus/api/edge.py:93-99 emits E_RESOURCE_CONFLICT for pre-handler database contention.

counterexample: a download read receives busy transaction409 without any source change; native publishes Changed and web claims a change.

smallest truthful fix: smallest copy repair: replace Changed text with cause-free `couldn’t download`; a more specific cause requires typed native code handling.

resolved when: pre-handler409 never renders a changed-original cause; real typed content change remains truthful.

verification: source only; no lab or native failure induced. root owns repository issue records and implementation.
