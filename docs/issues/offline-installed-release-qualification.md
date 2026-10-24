# installed offline release qualification

signed android `0.3.6` (code `26`) upgraded the installed `0.3.5` baseline without
clearing storage, paired with production source `400e7039e`, schema `0312`, wire
`14`. login and current reading chapter survived; downloads truthfully showed
an empty shelf. the old offline-rewrite storage-reset instructions no longer
apply to this installed baseline.

remaining installed-release journeys are `NOT_RUN`: sign-out purge/account
switch, cold packaged reading, interrupted transfer resume, task-manager stop,
and hosted/device position conflict resolution. an empty-shelf smoke check does
not qualify them. the startup cutover's physical acceptance belongs to
[offline startup release](release-offline-startup.md); [offline pdf
opening](offline-pdf-reader-open-failure.md) remains a separate defect.

resolve after these journeys pass or receive an explicit owner disposition.
record proof in the release pr; [offline](../modules/offline.md) owns the contracts.
