# source citation cutover

release remains outstanding. use the existing deployment controller and its
stopped-writer, verified-backup and exact-head checks.

- apply `0333_source_citations` after `0332`. it preserves existing
  citation ids/evidence/ordinals, removes account ownership from ordinal citations,
  adds occurrence bindings, backfills currently provable source references and
  adds nullable `attribution_text`/`completion_ref` and migrates observation lanes.
  original evidence remains the base; later proof does not replace it. native
  backfill quotes only proved authored text, excluding generated media labels.
  conversion errors require explicit
  data repair; do not bypass validation or invent lost historical excerpts.
- inspect the [legacy excerpt attribution](legacy-x-excerpt-attribution.md) data
  condition; migration preserves retained observations and cannot infer a lost
  historical body/attribution boundary.
- pair api/web/extension/android with the generated citation and evidence wire
  contract. wire 19 is the existing pending bump on `60e63dbaa`; recheck the actual
  release boundary before shipping and follow the once-between-releases rule.
- use the deployed x endpoint for normal acquisition. the optional
  `X_API_BASE_URL` passes through both api and workers; lab inputs explicitly
  select their owned external responder.
- qualify populated-database conversion, source/target authority, capture retention
  and ordinary message/oracle citations. source refresh deliberately retires old
  article citation ids; completion never changes canonical reading composition.

resolved when coordinated release and paired-client qualification succeed. local
implementation proof belongs in the pr, not this issue.
