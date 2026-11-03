# admission recovery labels retain uppercase

source: frozen `3643a20b466b135e17b5e5c196a00b030df872e2`; web paths under apps/web/src, native paths under apps/android/app/src/main/java/app/nexus/android.

problem and impact: admission recovery labels retain uppercase.

evidence: lib/actions/project.tsx:744 shows `Reload` or `Update Nexus`; :751 shows `Retry` for pending SourceRefresh/MetadataResearch admission. these are recovery verbs, not user titles; callbacks reload document or admissions.retry.

counterexample: an admission failure or stale-build pending command projects these recovery actions.

smallest truthful fix: use `reload`, `update nexus`, `retry` as applicable, retaining disabled Update behavior.

resolved when: actual recovery labels satisfy lowercase floor.

verification: source only; no lab run. root owns repository records and implementation.
