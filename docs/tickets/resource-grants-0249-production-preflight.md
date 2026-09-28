# 0249 needs a read-only production preflight before deploy

status: open · origin: 2026-09-28 resource-sharing reauthoring (size/resource-sharing) · area: resource sharing / production migration

`migrations/alembic/versions/0249_resource_grant_constraints.py` adds
`ck_resource_grants_subject_scheme`, `ck_resource_grants_one_audience` and the
partial unique indexes `uq_resource_grants_person` and `uq_resource_grants_link`,
and drops `ix_resource_grants_creator_subject`. its upgrade first counts rows
that would violate them: a subject scheme other than `media`/`highlight`, a row
with zero or two audiences, or a second person or link grant for one
(creator, subject[, grantee]). a nonzero count raises and the upgrade stops.
nobody has run that count against production.

impact: a malformed or duplicate production row fails the deploy at
migration time. link rows are bearer links someone may hold, so the migration
deliberately never rewrites or deletes one.

prerequisite: read access to the production database. run the `WITH bad AS (…)`
SELECT from `upgrade()` verbatim, read-only, before merging this branch into a
deploy. if it returns rows, stop: inspect each id, keep the oldest link grant a
holder may have received, and delete or repair the rest by hand under a writer
fence, then rerun the count.

acceptance: a recorded production count of zero, then 0249 applies and
`\d resource_grants` shows the two checks and two partial unique indexes.
delete this ticket after the evidence is recorded.
