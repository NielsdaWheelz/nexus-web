# stalled connection uploads wait for capability expiry

the 2026-10-10 graph qualification observed about 120 seconds without a failure
notice for a failed presigned upload. pending feedback was subsequently added;
the remaining decision is how long a stalled upload should wait.

`apps/web/src/lib/imports/ingest.ts` bounds the PUT by the signed capability's
`expires_at`, then reports `BytesMissing`. a hung request can therefore remain
pending through that capability window. the
[import contract](../modules/imports.md) owns transfer and confirmation.

decide whether an earlier transfer deadline is warranted. resolve when an actual
held or rejected PUT exposes waiting in the existing attachment control and an
actionable failure when the client gives up, without writing a link, moving
content or taking focus. removing pending copy alone does not settle the deadline.
