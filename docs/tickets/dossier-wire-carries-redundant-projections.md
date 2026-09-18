# the dossier wire carries redundant failure and manifest projections

status: open · origin: 2026-09-17 slop sweep (claude session) · area: dossiers ·
oi-157

three wire-side removals fall out of the artifacts slice and belong together,
ahead of the DDL in oi-152.

ART-05: `support` is projected but carries nothing a reader uses. drop it from
`FailedEventPayload` and `HistoricalFailedEventPayload`
(`services/artifacts/dossier_types.py`), `failure_support` from
`DossierUnsuccessfulBuildView` and `api/routes/dossiers.py:233,239`, and the
three TS decoders (`lib/dossiers/eventDecoder.ts:104-116`,
`dossierWire.ts:659-665`, `dossierControllerTypes.ts:191-196`). the
`artifact_build_failures.support` column and its CHECK then go in oi-152.

ART-16: `artifact_learn_failures.error_code` is NOT NULL and
`record_learn_unresolved` writes a literal into it until the column is dropped;
remove the code side here, the column in oi-152.

ART-13: `IdeaInputManifestOut` (`services/artifacts/manifests.py:166-174`) is
`IdeaInputManifestV1` minus `idea_subject_id`, `InputManifestOut` (176-186)
re-declares the same eight-member discriminated union with that substitution,
and `project_manifest_to_wire` (189-205) exists only to strip the field for the
one account that owns the idea. delete all three, have `_manifest_and_coverage`
return `InputManifestV1`, and point `DossierRevisionOut.input_manifest` and
`DossierRevisionSummaryOut.input_manifest` at it.

the ART-13 landmine: `apps/web/src/lib/dossiers/dossierWire.ts:337-348` decodes
the idea manifest with `expectExactRecord`, and `lib/validation.ts` rejects any
record whose key set differs from the declared list. `"idea_subject_id"` must be
added to that key array in the same commit, or every idea dossier revision
fails to decode. no static gate catches this.

also in this change: rename `seal_artifact_build` / `unseal_artifact_build`,
which no longer seal anything, and correct
`docs/architecture.md:1046-1047`, which still describes a `{sealed_handle}`.

prerequisite: none for the wire removals. the matching DDL waits for oi-152.

acceptance: load an idea dossier revision in the pane after the ART-13 commit
and see it render; no `support` or `failure_support` symbol remains in python or
web; `./scripts/test` passes.
