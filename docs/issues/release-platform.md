# release: platform substrate, owed owner checks

status: shipped; owner checks owed
origin: config, storage, the api substrate and the replay-ledger drop (0286);
shipped in `83459f1b8` and `fdd0a3e` (schema 0287, wire 2) on 2026-10-15
area: release / platform

done:

- every retired backend key is absent from the published application keys
  (book campaign `coordinator/final1c07/env-published-readback.json`).
- vercel `CSP_MEDIA_ORIGINS` is not among the live-derived frontend keys, and
  the publication retired no such key (`coordinator/final1c07/env-preparation.json`).
  afaict it was never set; if it is, extra env is ignored.
- config loads in prod: the api and both workers came up healthy, and config
  refuses at startup. vercel builds resolve `getEnv()`, so the origins are bare.
- 0286 ran (`coordinator/final83459/canonical-release/root-review.json`).
- passed: sign-in, pdf and epub reading, and an offline copy on the phone
  (`coordinator/finalfdd0a3e/usable-release-acceptance.json`). the controller
  read back `/version` and readiness (`coordinator/finalfdd0a3e/canonical-release/root-review.json`).
- three checks sit elsewhere: share and public link with
  [atlas and share](release-atlas.md), the pdf upload with [ingest](release-ingest.md),
  and metadata research with
  [imports metadata proof](imports-live-metadata-proof-needs-working-search.md).

owed: no release record shows these in production.

- send a chat message, toggle the network off mid-send and back on, then retry
  send. the result is one turn.
- edit authors to add a new person and save. reopen the editor; the person is
  listed once.
- link two notes from the link composer.
- pick a launcher result.

delete this file once the owner has run these or waived them.
