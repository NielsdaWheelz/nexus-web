# dossier coverage is computed and dropped

status: open · origin: 2026-09-28 cleanup pr-08 (cleanup/dossier-latest-revision) · area: dossiers / typed wire

`python/nexus/api/routes/dossiers.py:96` (`_coverage`) projects the revision's
typed manifest into `DossierRevisionOut.coverage`, through six models
(`python/nexus/schemas/artifact.py:139-185`). the web never reads it: it derives
its coverage label from `input_manifest` instead
(`apps/web/src/components/dossier/dossierCoverage.ts`), so the same fact is
computed twice and one copy is shipped unused on every head read.

fix: keep one. either render `coverage` and delete `dossierCoverage.ts`, or
delete `_coverage`, the six coverage models and the field (a wire change: the
web deploys first and ignores the extra field until then).

resolved when: the head carries coverage once and the web reads that one.
