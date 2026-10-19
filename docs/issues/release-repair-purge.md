# release steps owed by the repair purge

status: open · origin: 2026-10-18 repair purge (cleanup/repair-purge) · area: release / migrations

the purge deletes the one-time repair and cutover code and squashes 0236–0292
into the `0292` baseline. production's `alembic_version` already reads `0292`,
the baseline's revision, so the release is ordinary: `deploy.sh <sha>` backs up,
then `alembic upgrade head` runs only the revisions after 0292 that ship with it.
the drop of `model_cutover_archives` is not in this purge; it waits for the r2
retention read ([issue](backup-retention-policy-unverified.md)).

## after the release: retire the old-image env keys

the rollback window closed on 2026-10-18, so the keys only the `7dc68929b` image
read can go (`deploy/env/README.md`). `deploy/env/env-prod-backend` still names
`GENERATION_CONTINUATION_ENCRYPTION_KEY`, `AGENT_TOOL_GRANT_SIGNING_KEY`,
`MOONSHOT_GENERATION_API_KEY`, `BILLING_ENABLED` and eight `STRIPE_*` keys
(checked 2026-10-19); no current code reads any of them. the billing ones are
[their own step](billing-0252-release-steps.md). remove them and re-run
`deploy/hetzner/sync-env.sh`.

resolved when: a release carrying the squash has run (`alembic current` reads
its head under the new graph) and the env file holds none of those keys. delete
this file then.
