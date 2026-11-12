# daily work installed acceptance

production `dbaa832ea` reached schema `0341`, wire `21` and authored format `6`
on 2026-11-12. the daily-work and librarian migrations shipped together after
the newest-backup rehearsal and the canonical stopped-writer, verified-backup
release. the owner confirmed devices synced and closed before cutover.

server checks retained all 1,036 original changes and source prefixes. six active
replicas now admit format `6`; three retired format-3 replicas remain unchanged.
these server facts do not establish an installed device's snapshot or outbox.

remaining: observe the paired browser/android upgrade, retained writing identity,
offline reopen and reconnect, a task completion and a habit date correction.
devices must finish their complete fenced snapshot before new writing resumes.
preserve local identity, source counters and pending bytes; never clear storage
or rewrite commands to pass the upgrade.

the durable contract lives in [notes](../modules/notes.md) and the
[local-first cutover](release-local-first-writing.md). resolve after installed
devices retain their old writing and exchange new work facts, with actual
device observations distinguished from disposable proof in the release pr.
