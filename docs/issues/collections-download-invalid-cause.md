# download state claims file damage for broader native failures

source: frozen `3643a20b466b135e17b5e5c196a00b030df872e2`.

problem and impact: download state claims file damage for broader native failures. the user receives an unsupported cause.

evidence: apps/web/src/app/(authenticated)/downloads/DownloadsPaneBody.tsx:32 maps Invalid to `the downloaded file was damaged`. apps/android/app/src/main/java/app/nexus/android/offline/Transfers.kt:154 maps no supported audio mime to Invalid; :159 maps TimeoutException/ExecutionException/ExoPlaybackException to Invalid; :91 also maps absent body.

counterexample: an intact unsupported-codec audio file or probe timeout displays damage despite no proof of corruption.

smallest truthful fix: use `couldn’t use the downloaded file` (or equally broad truthful text) for Invalid.

resolved when: unsupported audio, probe timeout and malformed bytes share copy that each actually proves.

verification: source only; no lab or native failure induced. root owns repository issue records and implementation.
