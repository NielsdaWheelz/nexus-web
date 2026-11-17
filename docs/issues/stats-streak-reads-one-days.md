# the stats streak tile reads "1 days"

status: open · found 2026-11-16 in the lab · area: stats

problem: the tile prints `{count(totals.streak)} days` with no singular
(`apps/web/src/app/(authenticated)/stats/StatsPaneBody.tsx:991`); a one-day streak reads
"1 days".

resolved when: a one-day streak reads "1 day".
