# extension receipt rejects the current media summary

installed firefox extension 1.1.4 (`833eb09a7`, wire 24) saves the article but
then stops with “the extension stopped unexpectedly.” the same contract remains
in backend/client source `b666d936f`. the 2026-11-16 recovery returned 200 for
confirmation, source attempt and `/extension/items/{media_id}`; one capture
session, one source attempt and one succeeded ingest job remained.

`python/nexus/schemas/media_summary.py:84` includes `publisher_publication`
(introduced in `c152c4064`). `apps/web/src/extension/nexusClient.ts:50` omits it
from the nested summary's `expectExactRecord` keys. a valid response therefore
throws before the receipt's consumed fields are projected; `background.ts:216`
turns that defect into the stopped-extension state. this predates the host move.

fix the nested summary projection boundary: accept a record and validate the
four consumed fields with their existing decoders. keep extension-owned envelopes
and commands exact. adding another unused key to the copied full-schema list
retains the coupling that caused this defect.

resolved when the actual saved-item response decodes, invalid consumed fields
still fail, and the installed extension displays that existing receipt without
another capture, source attempt or ingest job. the separate first-confirmation
latency remains in [its own issue](capture-confirmation-exceeds-client-deadline.md).
