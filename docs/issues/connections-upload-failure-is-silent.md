# a stalled Connections upload fails only when its capability expires

status: open · origin: 2026-10-10 graph slice harness (coordinator review R5) · area: connections / media upload

on Connections, attaching a file whose presigned PUT fails gave no notice for about
120 s in the graph slice harness. since #646 the surface shows "uploading and
linking…" while `components/connections/useConnectionAttachments.tsx` runs
(`attaching`), so the pending state is no longer silent. the residual:
`lib/imports/ingest.ts` `putAndConfirm` waits until the signed url's `expires_at`
(five minutes) for a hung PUT before it throws `BytesMissing`, so a stalled upload
shows "uploading and linking…" for the whole capability window before its failure.

fix: decide whether a stalled PUT should fail sooner than the capability window.

done when: a PUT the harness holds or rejects produces a visible pending notice at
once and a failure notice when the client gives up, with no link written.
