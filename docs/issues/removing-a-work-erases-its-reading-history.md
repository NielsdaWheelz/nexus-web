# removing a work erases its reading history

status: open · found 2026-11-16 by reading at `fcd6843db`; not run · area: consumption activity

problem: media teardown deletes the work's activity spans, exclusions and completion
facts (`python/nexus/services/consumption/state.py:395-410`), and every record query
joins visible media (`python/nexus/services/consumption/stats.py`, `_base_sql`).

impact: removing a work erases its stack spine and its minutes from the slip;
weeks running and records can change retrospectively.

owner decision 2026-11-17: the stacks change preserves erasure. history that
outlives removal is a separate next specification; this issue remains its home.

proposed fix (if the record should outlive the copy): teardown keeps spans and
completion facts with the media reference cleared and a snapshot of title and credits
kept, one alembic migration that states its data effects.

resolved when: removing a finished work leaves its hours, days and completion in stats,
attributed to its title snapshot, under the separate history-retention specification.
