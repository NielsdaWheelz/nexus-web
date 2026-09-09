# Proof registry repointed at the Imports successor node ahead of Track F

**Status:** open (Track F to complete)
**Origin:** 2026-09-08, imports workspace hard cutover, Tracks C2 and E
**Area:** `testdata/proofs.json`, `testdata/faults/manifest.json`,
`python/nexus_test_control/model.py`, `python/tests/kernel/nexus_test_control/test_selection.py`

## What is wrong

Deleting `test_media_activity*.py` (contract §4) made `./scripts/test changed`
abort for every track at `selection.py:208` ("priority proof owner is missing").
To keep the tree runnable, Track C2 made the narrowest registry edit:
`document-import-reliability` now names
`pytest:python/tests/service/test_imports.py::test_history_stage_and_date_filters_must_be_satisfied_by_one_event`
(the node the `imports-history-correlation-bypass` fault targets) in place of the
three deleted proofs, its two `media_activity` source globs became
`schemas/imports.py` / `services/imports.py`, the `durable-ingest-reader-open`
journey globs point at `api/routes/imports.py`, `services/imports.py`, and
`apps/web/src/app/api/imports/**/*`, the three faults naming deleted proofs were
removed with their patches, `PRIORITY_RISK_OWNERSHIP_SHA256` was recomputed, and
`test_selection.py`'s expected sets follow.

Track E then deleted
`apps/web/src/components/nexus/MediaActivityPage.browser.test.tsx` (contract §6),
which aborted `./scripts/test changed` for every track again at the same line.
Track E made the same narrowest edit: `document-import-reliability` now names
`vitest:apps/web/src/components/imports/ImportsWorkspace.browser.test.tsx` in
place of the deleted browser owner, its `lib/status/mediaActivity.ts` and
`components/nexus/MediaActivityPage.tsx` source globs became
`lib/status/imports.ts` and `components/imports/**/*`,
`PRIORITY_RISK_OWNERSHIP_SHA256` was recomputed
(`7cc74870c896a755ffb3e93efae409f617aafd45e40c0bacc22cd31e947cb9b8`), and
`test_selection.py`'s two expected sets follow. `./scripts/test changed` passes.

Still Track F's (contract §7/§8): the remaining new module globs, the
`imports-history-correlation-bypass` fault (Track C2's recommended node and
patch idea are in its report), retargeting `document-import-upload-retry-ui-bypass`,
the deleted browser paths still named by the registry
(`lib/media/activityClient.ts`, `MediaActivityProvider.tsx`, and the
`durable-ingest-reader-open` journey's `MediaActivityPage.tsx` /
`MediaActivityProvider.tsx` / `activityClient.ts` globs), the retargeted
`document-import-upload-retry-ui-bypass` fault (Track E's browser owner is now
its canonical node; a patch that hides the `Retry upload` offer in
`components/imports/ImportRow.tsx` fails three of its named cases — see
`<scratchpad>/evidence/E-sensitivity.txt`), and the deleted
`python/nexus/api/routes/media_activity.py` references in docs.

## Acceptance

`./scripts/test confidence` policy passes with every glob matching a file and one
fault per new canonical node.
