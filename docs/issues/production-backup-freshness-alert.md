# backup failure has no independent notification

owner decision, 2026-11-15: accept manual backup checks for the dev-server move.
automatic alerts and a new monitoring service are out of scope. this is an
accepted detection limitation, not a fixed defect. the nominal nightly loss
window can grow beyond a day if failed backups go unnoticed.

`deployment.md`'s manual freshness contract and
`deploy/hetzner/release.py::assert_backup_fresh` check listed archive age only;
with the timer enabled, `--check` fails after 36 hours. nightly failures or a dead host can therefore
leave recovery points aging without notifying the owner between releases.
this is a source-contract gap; live backup age was not inspected on 2026-11-15.

if this decision changes, add one independently hosted freshness/dead-man check with an owner notification.
report success only after the canonical backup has uploaded and verified its
archive. preserve the existing backup owner and its release/nightly lock; do not
build a second backup scheduler or expose backup credentials to the monitor.

resolved when a successful verified backup refreshes the signal and an omitted
or failed backup produces a delivered notification within a declared alert
deadline, including when the application host is unavailable.
