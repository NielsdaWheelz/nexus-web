# the stats day view fails on a date its zone skips

status: open · origin: 2026-09-28, size/consumption-stats reauthoring · area: consumption / stats pane · p3

a zone that skips a whole calendar date (Pacific/Apia 2011-12-30, Kwajalein
1993-08-21) gives that date's day view `start == end`: both local midnights
resolve to the same instant (`statsPeriod.ts` `zonedMidnight`). the api answers
400 `Invalid Consumption range` (`stats.py:67`, `scope.start >= scope.end`) and
the pane shows "Stats could not load" (`StatsPaneBody.tsx:899`). the old code
showed the previous local day's data under that date. the sql side already
gives such a date no bucket.

impact: none in practice. both dates predate the 30-day capture window, so no
span can exist; a reader must navigate there by hand.

fix: an empty range is a valid empty period: `resolve_scope` rejects only
`start > end`, and every query already returns nothing for an empty range. do it
with [stats-local-midnight-rule-has-two-owners](stats-local-midnight-rule-has-two-owners.md)
if that lands first, since local dates on the wire move the check.

acceptance: with timeZone Pacific/Apia, the day view of 2011-12-30 renders the
empty state, and `GET /consumption/stats` with `start == end` answers 200 with
zero totals.
