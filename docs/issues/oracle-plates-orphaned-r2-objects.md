# 36 orphaned oracle plate objects in r2

status: open · origin: 2026-10-04 oracle rewrite (cleanup/oracle-reauthor, migration 0262) · area: oracle / storage

plates became static web assets (`apps/web/public/oracle-plates/<key>.jpg`) and
migration 0262 dropped `oracle_plates`. the 36 production objects under
`oracle/plates/` in the media bucket now have no owner row and no reader; the
storage orphan sweep does not know the prefix.

prerequisite: 0262 released and the plates verified served from the web origin.
fix: list `oracle/plates/` and delete exactly those 36 keys once.
acceptance: the prefix is empty and no plate request 404s.
