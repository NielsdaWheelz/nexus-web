# release the reading record

status: pending paired deployment and installed-client replacement.

this change cuts the consumption reads over at wire 25, without a migration.
`GET /consumption/stats` and `/consumption/sessions` disappear; record, work
record and sittings replace them. deploy api and web together.

the installed android apk bundles the old stats pane
(`apps/web/vite.android.config.ts`); the firefox extension sends its bundled
wire on every request (`apps/web/src/extension/nexusClient.ts`). current installed
clients are on wire 24; retain the qualification scope recorded in
[release-installed-clients-wire24.md](release-installed-clients-wire24.md).
after paired deployment, build, sign and install both at wire 25. until updated,
both receive 426. preserve their local storage when replacing them.

replace android promptly and within thirty days of the deploy. ingest skips
individual observations older than thirty days, even when their batch succeeds
(`python/nexus/services/consumption/activity.py:35`, `record`). each queued span
ages from its own observation time, so an existing backlog has less headroom.

sigla had not merged when the pane implementation began. records therefore use
a two-column `dl`; section heads use `PaneSection` without their own font role.
when integrating sigla, drop its edits to the deleted stats body and use its
shared ledger for these same record lines.

resolved when the paired deployment is healthy and the signed extension and apk
are installed at wire 25 with retained identity/storage and successful new-wire
requests. record exact source, versions and observed scope in the release pr.
