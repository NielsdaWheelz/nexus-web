# release: connection actions

status: source implementation complete; production release pending. owner approved
deleting every existing discovery suppression on 2026-10-19. migration `0298`
follows `0297`; wire 12 retains the existing unreleased break. production backup
rehearsal, migration, deployment and smoke acceptance remain outstanding.

data effect: one migration after actual head drops
`connection_discovery_suppressions`, including all preferences. no resource,
edge, note, message or assistant receipt is rewritten. previously dismissed
pairs become eligible on subsequent ordinary scans; no bulk rescan is started.

before release:

- recheck actual migration head and deployed ancestry. this change's head is `0298`;
  do not claim production has reached it. existing ancestor migration blockers
  remain owned by [resource insertion](release-resource-insertion.md) and its
  linked cutover records; do not bypass them in this change.
- rehearse the combined head on the newest verified backup; record aggregate
  suppression row count. verify this drop changes no protected product data,
  separately from intentional data changes in ancestor migrations.
- apply the repository's release boundary rule to wire pairing. source currently
  uses wire 12 for an unreleased break; retain it if still in that same release,
  otherwise bump exactly once for the new break. regenerate all paired consumers.
- through the standard deployment controller, stop old api/worker writers,
  retain a verified backup, migrate to the exact combined head, and start only
  paired api/web/worker clients. no old dismissal route or schema compatibility
  reader survives. no new environment setting is needed.

after release, verify deployed source identity and exact schema head, then use
explicitly scoped disposable own records to check exact machine removal, both
books surviving, live cross-view settlement and absence of the suppression table.
clean up those records. production mutations require scoped deployment/smoke
authority; this specification does not grant it.

keep this record until backup rehearsal, paired deployment and live acceptance are each
independently complete, with actual observations in the pr.
