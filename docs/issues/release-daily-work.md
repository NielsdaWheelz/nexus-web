# daily work installed acceptance

production `dbaa832ea` reached schema `0341`, wire `21` and authored format `6`
on 2026-11-12. the daily-work and librarian migrations shipped together after
the newest-backup rehearsal and the canonical stopped-writer, verified-backup
release. the owner confirmed devices synced and closed before cutover.

server checks retained all 1,036 original changes and source prefixes. six active
replicas now admit format `6`; three retired format-3 replicas remain unchanged.
these server facts alone do not establish an installed device's snapshot or outbox.

the physical phone upgraded in place from `0.3.12` to `0.3.13`, retaining its
account and old writing. an offline edit survived force-stop/reopen with both
radios disabled, then reached production after reconnection on the original
format-6 replica with its accepted sequence advanced. no app data was cleared.

remaining: a task completion and habit date correction on the installed phone.
the owner deferred this release's [desktop browser checks](release-browser-client-acceptance.md).
preserve local identity, source counters and pending bytes in later upgrades;
never clear storage or rewrite commands to pass them.

the durable contract lives in [notes](../modules/notes.md) and the
[local-first cutover](release-local-first-writing.md). resolve after the remaining
work-specific observations pass, distinguishing actual device observations from
disposable proof in the release pr.
