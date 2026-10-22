# release steps owed by the repair purge

status: open · origin: 2026-10-18 repair purge (cleanup/repair-purge) · area: release / migrations

the purge's squash and later migrations shipped in production `99320b630` on
2026-10-22; `alembic_version` reads 0306 under the new graph. 0304 dropped
`model_cutover_archives`; the verified stopped-writer release backup retains the
prior archive row. migration activation is complete; obsolete env keys remain
this record's independent cleanup step.

## after the release: retire the old-image env keys

the rollback window closed on 2026-10-18, so the keys only the `7dc68929b` image
read can go (`deploy/env/README.md`). `deploy/env/env-prod-backend` still names
`GENERATION_CONTINUATION_ENCRYPTION_KEY`, `AGENT_TOOL_GRANT_SIGNING_KEY`,
`MOONSHOT_GENERATION_API_KEY`, `BILLING_ENABLED` and eight `STRIPE_*` keys
(checked 2026-10-19); no current code reads any of them. the billing ones are
[their own step](billing-0252-release-steps.md). first resolve
[production configuration drift](production-config-inputs-drift.md): the local
publisher inputs do not reproduce the intended active configuration. remove the
retired keys during that reconciliation and validate the complete publication
diff before running `deploy/hetzner/sync-env.sh`.

resolved when: a release carrying the squash has run (`alembic current` reads
its head under the new graph) and the env file holds none of those keys. delete
this file then.
