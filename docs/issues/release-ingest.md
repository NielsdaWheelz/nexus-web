# release: ingest, owed owner checks

status: shipped; owner checks owed
origin: source lifecycle, uploads, the firefox capture and the share page;
shipped in `83459f1b8` and `fdd0a3e` (schema 0287, wire 2) on 2026-10-15
area: release / ingest

done:

- 0282 and 0283 ran; 0282 refuses on any nonzero census (book campaign
  `coordinator/final83459/canonical-release/root-review.json`).
- the release census read zero jobless indexes and zero jobless latest sources
  (`coordinator/finalfdd0a3e/release-census/receipt.json`).
- env: `INGEST_RECONCILE_SCHEDULE_SECONDS` was removed.
  `INGEST_STALE_EXTRACTING_SECONDS` and
  `STORAGE_OBJECT_CLEANUP_WRITE_WINDOW_SECONDS` are absent from the published
  keys (`coordinator/final1c07/env-preparation.json`, `env-published-readback.json`).
- r2: `expire-direct-upload-staging` expires `uploads/` objects after one day,
  and an object outside that prefix keeps no expiry
  (`coordinator/final1c07/r2-lifecycle-accepted.json`).
- wire 10 took a genuine firefox capture to a readable source with import
  history (received status only, see
  [wire10 evidence](wire10-qualification-evidence-not-retained.md)).
- the post room worker and its smoke sit with the
  [post room](production-post-room-unconfigured.md); signed extension
  distribution sits with [its issue](extension-firefox-distribution-consent-is-undeclared.md);
  imports retries sit with [imports](release-imports.md).

owed: no release record shows these in production.

- add a url, then add it again; the same media answers at once.
- retry a failed source from imports twice; both succeed.
- refresh an email article, if one exists.
- upload a pdf from add.
- kill the network mid-upload, then retry upload. the result is one media, with
  the session at generation 2.
- firefox: capture an article and a pdf link into two libraries. block one put
  and retry it. discard a draft.
- phone: share a url, then plain text.

delete this file once the owner has run these or waived them.
