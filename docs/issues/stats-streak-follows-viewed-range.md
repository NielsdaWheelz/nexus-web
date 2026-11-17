# the stats streak follows the viewed range

status: open · found 2026-11-16 by reading and in the lab · area: consumption activity / stats

design question: streak and longest streak use qualifying days inside the
requested range only (`python/nexus/services/consumption/stats.py:288-302`), so
changing the viewed period changes these figures.

evidence: in a lab seeded with a 9-day streak ending today, the week view's tile read
"7 days" (`now-dark-week-1.png`, 2026-11-15).

unapproved option: compute current and longest streak over all recorded days,
independently of the viewed period.

the current owner explicitly computes range-local streaks and labels historical
ranges `ending streak`. changing that meaning needs a product decision; the
reported mismatch is not evidence of an arithmetic error.

resolved when the owner retains and documents range-local meaning, or adopts
all-time meaning and verifies that day, week and month views report it consistently.
