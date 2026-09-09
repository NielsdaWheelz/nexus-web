# `E_PDF_TEXT_UNAVAILABLE` is a catalogued code that names no failure

**Status:** open (Track E half done 2026-09-08; Track B's emission assertion remains)
**Origin:** Imports workspace cutover, Track A review, 2026-09-08
**Area:** `python/nexus/schemas/import_history.py` (`SafeFailureCode`);
`apps/web/src/lib/status/imports.ts` (Track E, not yet written);
`python/nexus/services/media_source_ingest.py` (Track B emission points)

## What is wrong

`media.last_error_code` is one of the trusted columns `assume_safe_failure_code`
narrows (contract D5). `mark_stage_warning`
(`python/nexus/services/media_processing_state.py`) writes the bare string
`"E_PDF_TEXT_UNAVAILABLE"` to it from `_SourceTerminalPublication.publish`
(`media_source_ingest.py`) on **success**: the PDF is ready for reading, its
text layer is not extractable, and OCR would be required. `processing_status`
stays `ready_for_reading`; `failure_stage` and `failed_at` are set anyway.

The catalog now names the code (otherwise `assume_safe_failure_code` defects and
the 0225 preflight would refuse a database holding it on
`media_source_attempts.error_code`, which
`media_source_ingest.py:491-494` can copy from `media.last_error_code`). But
every other member of `SafeFailureCode` names a real failure, and two owners
read the column as one:

- contract §3 has Track B record `SourceFailed{..., code=media.last_error_code}`
  for an attempt born `failed` and for the failed publish branch;
- contract §6 has Track E hold one copy record per `SafeFailureCode` with a
  "short reason line" and whether the same source can help.

A reader whose PDF imported successfully must never be told it failed.

## Prerequisites

Track B's emission points and Track E's copy owner.

## Proposed fix

Either (a) give the code a copy record that states the outcome truthfully
("Imported without selectable text") and have Track B assert it is never the
code of a `SourceFailed` event, or (b) stop overloading `media.last_error_code`
for non-terminal warnings — give the warning its own column or its own
`StageChanged`-shaped history event — and drop the code from `SafeFailureCode`.
(b) is the smaller vocabulary but touches an existing shared column.

## Acceptance

An import whose only recorded code is `E_PDF_TEXT_UNAVAILABLE` reads as
complete in the Imports workspace, and a proof fails if that code ever reaches
a `Failed` history row.

## Track E note (2026-09-08)

`lib/status/imports.ts` now holds the honest record for this code — reason
"Imported without selectable text", title "This PDF has no selectable text.",
explanation "It can be read as pages; search and quoting need OCR first.", and
no recovery offer — so a reader whose PDF imported successfully is never told it
failed. That is option (a)'s copy half. Option (a)'s other half is still open:
Track B must assert that `E_PDF_TEXT_UNAVAILABLE` is never the `failure_code` of
a `SourceFailed` history event, because nothing structural prevents it today.
