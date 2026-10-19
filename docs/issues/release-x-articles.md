# native x article activation

release work remains; source qualification does not activate production.

- pair api, web, rebuilt firefox extension and android's packaged shelf on wire
  12. `android-v0.3.4` carries wire 11; older clients must update. capture intent
  now requires nullable `x_article_binding`; old unbound unfinished x article
  sessions require recapture. packet bytes/hashes and published receipts stay valid.
- apply `0295_x_articles` after main's `0294_assistant_link_check`, following the
  release controller's stopped writers, backup, ancestry and exact-head checks.
  canonical source migration 0293 has [separate prerequisites](release-x-thread-imports.md).
  0295 creates empty inspections/current-publication tables, backfills nullable
  capture bindings, and preserves old captures/annotations. supersession owners
  derive only from an original attempt or unambiguous surviving job; unknown
  owners stay null and old uuid retries refuse. no duplicate conversion occurs.
- disposable previews with the former unmerged `0294_x_article_inspections`
  must be recreated; that revision is not main's 0294. never stamp it as main's
  migration. inspect ancestry before activating a persistent database.
- configure `X_API_BEARER_TOKEN` in both api and workers through their existing
  private config. the api also needs it for article-page identity lookup when
  no verified local carrier association exists. missing credentials fail closed.
- all older text downloads lack required `x_article_content`. the shelf refuses
  them without deleting bytes/positions. sync/check pending positions before
  remove-and-download-again; removal deletes device progress. no archive migration.

api articles intentionally preserve available prose with visible limits, not
original formatting/media or certified completeness. browser capture replaces
the matching native article and becomes its update path; api refresh then refuses.
remote browser images are not archived. old copies remain independent.

resolve after paired release/migration and installed-device acceptance: status
import opens its thread and separate api article, article preview opens it,
firefox replaces that same article, search finds the new body, and a new offline
copy shows the correct notice. full combined live provider qualification remains
[separately recorded](x-author-thread-live-qualification.md).
