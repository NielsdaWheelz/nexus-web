# The Imports upload retry guard cannot check the file's size

**Status:** open (accepted reduction; the server fence is the backstop)
**Origin:** 2026-09-08, imports workspace hard cutover, Track E
**Area:** `apps/web/src/components/imports/ImportRow.tsx`;
`python/nexus/schemas/imports.py` (`ImportItem`)

## What is wrong

The retired Activity row carried `filename`, `expected_size_bytes` and
`document_kind` for an upload session, so `Retry upload` refused a file whose
name, size or kind differed before sending any bytes
(`MediaActivityPage.tsx:271-283`, now deleted).

`ImportItem` (contract §4) carries only `title` (the filename) and `media_kind`,
so the browser guard can compare the name and the derived upload kind but not
the size. A same-named, same-kind file of a different size now reaches the
server, which refuses it with `E_UPLOAD_INTENT_MISMATCH`
(`uploadSessionOutcome("Retry", …) -> FileMismatch`) and the reader is told
"That file doesn't match this import. Choose the same file, or start a new
import." — one round trip later than before, with the bytes uploaded first.

## Prerequisites

A wire decision: either `ImportItem` gains the upload intent's `size_bytes`
(only meaningful for an unpublished upload obligation, so it would be a
`Presence` field), or the reduction is accepted as final.

## Proposed fix

Add `upload_intent: Presence<{size_bytes}>` to `ImportItem` for unpublished
upload sessions, decode it in `lib/imports/importsClient.ts`, and restore the
size comparison in `ImportRow`'s guard.

## Acceptance

a manual retry with the same filename and kind but a different size is refused
before any put or `/retry` request, as observed in browser network activity.
