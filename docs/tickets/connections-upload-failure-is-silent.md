# a failed Connections upload shows nothing for minutes

status: open · origin: 2026-10-10 graph slice harness (coordinator review R5) · area: connections / media upload

on Connections, attaching a file whose presigned PUT fails gave no notice for about
120 s in the graph slice harness. `components/connections/ConnectionsSurface.tsx`
`attachFiles` awaits `uploadIngestFile` and only publishes a notice when it throws;
`lib/imports/ingest.ts` `putAndConfirm` waits up to
`DIRECT_UPLOAD_PUT_TIMEOUT_MS` (240 s, capped by the capability's expiry) for a hung
PUT before it reports the transport failure. the surface shows no progress or
pending state meanwhile (`attaching` only blocks a second drop).

fix: show the upload as pending on Connections from the first byte (the same notice
key the failure later replaces), and decide whether a stalled PUT should fail
sooner than the capability window.

done when: a PUT the harness holds or rejects produces a visible pending notice at
once and a failure notice when the client gives up, with no link written.
