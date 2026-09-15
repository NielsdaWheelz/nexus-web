# reader publication runbook names the wrong migration

status: open
origin: 2026-09-14, restoration audit of 98a8b63bf0e72da5cb7e82ba2a9098716de58c84
area: production release documentation

`deployment.md:486` says reader publication generations are introduced by
revision 0216. the owning migration is
`migrations/alembic/versions/0219_reader_publications.py`; 0216 owns shared-agent
kernel changes. this can misdirect the later release's data preflight.

prerequisite: reconcile the complete db0215-to-db0229 release runbook with the
restoration migration ledger before any production authorization.

fix: correct the migration reference in the release preparation change.
acceptance: the runbook names db0219 and agrees with the rehearsed migration
chain and the reader publication preflight owner.
