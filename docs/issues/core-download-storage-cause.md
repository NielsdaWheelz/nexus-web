# download refusal claims disk exhaustion without proof

source: frozen `3643a20b466b135e17b5e5c196a00b030df872e2`.

problem and impact: download refusal claims disk exhaustion without proof. the user receives an unsupported cause.

evidence: apps/web/src/lib/actions/project.tsx:1017 says `this device is out of storage.` for code Storage. apps/android/app/src/main/java/app/nexus/android/offline/OfflineBridge.kt:108-111 converts any IOException from store initialize/dispatch into Storage, including permission or filesystem I/O faults.

counterexample: an IOException caused by a filesystem fault with ample free space takes the same Storage branch.

smallest truthful fix: use `couldn’t save to device storage.` as the reason, or omit the cause; do not narrow the native code to disk exhaustion.

resolved when: every reachable Storage producer entails the rendered reason, including non-capacity I/O.

verification: source only; no lab or native failure induced. root owns repository issue records and implementation.
