# The source-refusal sentence is duplicated in Python with no cross-language check

**Status:** open
**Origin:** Imports workspace cutover, Track C2 residual fixes (OI-027 fix),
2026-09-09
**Area:** `python/nexus/services/media_source_ingest.py`;
`apps/web/src/lib/media/mediaErrorMessage.ts`;
`python/tests/kernel/test_import_history_schema.py`

## What is wrong

Fixing OI-027 removed the "operator repair" claim from the refused source
actions and aligned the repairable-state refusal word-for-word with the copy
the browser already renders for the same state:

- `python/nexus/services/media_source_ingest.py:1834-1839` raises
  "Processing stopped before this import finished. Imports offers Retry stopped
  processing, which runs the stopped attempt again without creating a new one."
- `apps/web/src/lib/media/mediaErrorMessage.ts:105-112` renders the same title
  (`:109`) and the same second sentence (`:110`) for
  `processingStatus === "suspended"`, composed from
  `RESOURCE_ACTION_CATALOG["ResourceOperation.Media.RepairSource"].label`.

The two are now the same sentence in two languages with nothing that compares
them, which is the "parallel reason dictionary" the spec's content rubric
forbids (`docs/cutovers/imports-workspace-hard-cutover.md:25`). Renaming the
`RepairSource` catalog label, or rewording the browser presentation, leaves the
server sentence stale — on the wire, in logs, and in any surface that echoes
`error.message`.

## Prerequisites

None. `python/tests/kernel/test_import_history_schema.py` already owns the
cross-language mirror technique (it reads `apps/web/src/lib/imports/importRef.ts`
and `apps/web/src/lib/status/imports.ts` from the repository root).

## Proposed fix

Either (1) add a case to that kernel proof asserting the server sentence is
exactly the browser's suspended title plus its second explanation sentence,
with the `RepairSource` catalog label substituted, or (2) decide the server
message is diagnostic-only, and state the fact without quoting reader copy —
as the sibling refusal at `media_source_ingest.py:2584-2589` now does.

## Acceptance

Rewording the stopped-import copy in either language fails a proof, or the
server message no longer restates browser copy.
