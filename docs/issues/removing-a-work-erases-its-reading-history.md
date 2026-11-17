# removing a work erases its reading history

status: open · found 2026-11-16 by reading at `fcd6843db`; not run · area: consumption activity

problem: media teardown deletes the work's activity spans, exclusions and completion
facts (`python/nexus/services/consumption/state.py:395-410`), and every stats query
joins visible media (`python/nexus/services/consumption/stats.py:164`).

impact: tidying a library silently rewrites history: last year's hours shrink, a
finished work leaves the year's completions, and a past streak can break in retrospect.
any record, award or year-in-review built on these facts inherits the erasure.

prerequisite: an owner decision on whether removal means erasure. the reading-record
direction ("the book of hours", 2026-11-16) recommends that the record outlive the copy.

proposed fix (if the record should outlive the copy): teardown keeps spans and
completion facts with the media reference cleared and a snapshot of title and credits
kept, one alembic migration that states its data effects.

resolved when: removing a finished work leaves its hours, days and completion in stats,
attributed to its title snapshot, or the owner records erasure as intended and this file
is deleted.
