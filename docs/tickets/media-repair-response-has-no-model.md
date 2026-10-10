# media repair response has no response model

status: open · origin: 2026-10-09 web dead-code sweep (cleanup/web-dead-code, claude session) · area: imports / typed wire

`POST /media/{media_id}/repair` (`python/nexus/api/routes/media_ingest.py:178`)
returns `-> dict`, so `wire.gen.ts` types its 200 body as
`[key: string]: unknown`. the web therefore keeps handwritten
`decodeSourceAdmission` / `decodeSearchAdmission`
(`apps/web/src/lib/imports/importsClient.ts:71-105`) and decodes the repair reply
through `apiFetch<unknown>` + `decodeApiPayload` (`:208-240`), while the sibling
`retrySourceImport` (`:180-206`) already uses the generated
`ApiJson<"/media/{media_id}/retry", "post">`.

no runtime defect is claimed; the cost is a second, handwritten copy of a
server-owned shape.

fix: give the repair route a response model (the source/search admission union),
regenerate the wire, type `repairSourceImport` with `ApiJson`, and delete both
decoders.

acceptance: `wire.gen.ts` types the repair 200 body; `importsClient.ts` has no
handwritten admission decoder; `./scripts/test` passes.
