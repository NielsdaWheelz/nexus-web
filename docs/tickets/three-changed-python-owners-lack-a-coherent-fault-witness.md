# Three changed Python proof owners on the imports branch lack a coherent-fault witness

**Status:** open
**Origin:** Imports workspace cutover, final gates, 2026-09-11
**Area:** `testdata/faults/manifest.json`, `python/tests/service/{test_dossier_build_generation_detail,test_storage_orphan_sweep,test_media_upload_sessions}.py`

## What is wrong

The cutover's queue-claim hard cut (contract §3 D3) repointed two service proofs
at `tests.testkit.queue_claims.claim_job_row`, and its history events added
cases to `test_media_upload_sessions.py`. `pr` routes each changed owner to BASE
sensitivity; BASE cannot load `tests/service/conftest.py` on this branch (the
shared testkit imports `nexus.schemas.import_history`), so the standard's
coherent-fault path is the only one open. Eight owners were registered that way
(commit e4e731d4); three could not be:

- `test_dossier_build_generation_detail.py::test_head_projects_capacity_pause_and_admitted_selection_read_only`
  — no registered fault.
- `test_storage_orphan_sweep.py::test_storage_orphan_sweep_defects_on_a_malformed_persisted_page`
  — no registered fault.
- `test_media_upload_sessions.py` — its fault `document-import-upload-generation-bypass`
  owns the whole file; coherent-fault requires one exact node
  ("Whole-file owners ... fail closed").

## Evidence

- `pr` run d39bf5b0ab67324c on e4e731d4: the first BASE-routed owner fails at
  conftest import (`tests/testkit/unreachable_state.py:15`).
- `prove --against base:e3c6098e` for four sibling owners fails identically
  (runs 37363731374ab754, ce00c23482d08489, 90e2ae098fba3159, b67aceda2d53d34e).

## Prerequisites

None.

## Proposed fix

Register one product-only fault for each of the two unfaulted nodes (a patch
that reddens exactly that node with a stable fingerprint) and repoint
`document-import-upload-generation-bypass` at the exact node its patch reddens;
mark all three `changed_owner_red: coherent-fault` with pins from
`python_exact_proof_owner_sha256`. Verify with `prove --against fault:<id>`.

## Acceptance

`pr`'s sensitivity capability routes no Python owner on the branch to BASE.
