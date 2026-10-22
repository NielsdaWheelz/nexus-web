# release: api edge, owed owner checks

status: shipped; owner checks owed
origin: streams behind the bff and one wire revision; shipped in `83459f1b8`
and `fdd0a3e` (schema 0287, wire 2) on 2026-10-15
area: release / api edge

done:

- env: `NEXUS_HANDLE_KEY` carries the old `STREAM_TOKEN_SIGNING_KEY` byte for
  byte. the stream, podcast-flag and fable keys are gone. `STREAM_CORS_ORIGINS`
  was retired from `env-prod` and vercel (book campaign
  `coordinator/final1c07/env-preparation.json`, `env-published-readback.json`).
- fluid compute: every production web deploy since then carries
  `maxDuration = 300`, which vercel accepts only with fluid compute.
- email ingest stays unconfigured; [post room](production-post-room-unconfigured.md)
  owns it.
- order: queues were settled, then the controller ran, then the paired apk 0.3.2
  and a temporary extension went in (`coordinator/finalfdd0a3e/canonical-release/admission.json`,
  `usable-release-acceptance.json`).
- android J8: offline epub and pdf passed. J7: the native real-stack proof
  covers retained queues ([2026-10-15 release](../releases/2026-10-15-nexus.md)).
- smoke: wire 10 passed phone listening sync, offline copies and an extension
  capture (received status only, see
  [wire10 evidence](wire10-qualification-evidence-not-retained.md)).

owed: no release record shows this in production. ordinary use shows streaming
and the wire reload; it does not show cache headers.

- reader epub images and proxied images answer `private, max-age=86400`, and the
  second view is a cache hit.

the `/s` range read sits with [atlas and share](release-atlas.md).

delete this file once the owner has run these or waived them.
