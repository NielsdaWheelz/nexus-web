# reference read reason exposes banned failed wording

source: frozen `3643a20b466b135e17b5e5c196a00b030df872e2`; web paths under apps/web/src, native paths under apps/android/app/src/main/java/app/nexus/android.

problem and impact: reference read reason exposes banned failed wording.

evidence: lib/nexus/rows.ts:189 emits `resource lookup failed` when input.referenceFailed. useNexusController.ts:378,700 raises `${action.reason}.`; row text also uses that unavailable reason.

counterexample: a canonical resource lookup read fails, then activation speaks `resource lookup failed.`

smallest truthful fix: use `couldn’t look up this item` in the shared row producer.

resolved when: both row and activation present the same lowercase, cause-free truthful phrase.

verification: source only; no lab run. root owns repository records and implementation.
