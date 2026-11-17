# stats counts days in the browser's zone; the journal counts them in the account's

status: open · found 2026-11-16 by reading at `fcd6843db`; not run · area: consumption activity / stats

problem: the stats pane sends the browser's zone with every read
(`apps/web/src/app/(authenticated)/stats/StatsPaneBody.tsx:697`,
`useHydratedBrowserTimeZone`; `statsPeriod.ts:129-135` puts it in `time_zone`).
the journal, habits and the account's "today" use `users.calendar_time_zone`
(`apps/web/src/lib/notes/accountDay.tsx:15-17`), which defaults to `UTC`
(see `new-accounts-keep-utc-calendar.md`).

impact: a traveller, or anyone whose account zone was never set, sees stats and the
journal disagree about which day a sitting belonged to; the qualifying day, the streak
and the year's days move with the browser.

proposed fix: stats reads in the account zone; on the first stats visit where the two
zones differ, offer settings' existing "use {city}" once.

resolved when: a sitting read at 23:30 device time with a different account zone lands
on the same day in stats and in the journal.
