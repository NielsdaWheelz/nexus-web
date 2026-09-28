# the first-instant-of-a-local-day rule has two owners

status: open · origin: 2026-09-28, size/consumption-stats reauthoring · area: consumption / stats period math

`GET /consumption/stats` and `/consumption/sessions` take `start`/`end` as
instants. the pane computes them with `zonedMidnight`
(`apps/web/src/app/(authenticated)/stats/statsPeriod.ts:100`, three offset probes
over `Intl.DateTimeFormat`); postgres computes Day/Week/Month/Year bucket edges
with `_series` (`python/nexus/services/consumption/stats.py:603`, `AT TIME ZONE`
plus a three-hour-early reading). both implement one rule: a repeated local
midnight starts at its earlier reading, a skipped one at the transition. before
this branch they disagreed (America/Santiago 2026-09-06: web 03:00Z, postgres
04:00Z; America/Havana 2025-11-02: postgres 05:00Z, web 04:00Z). they agree now,
by cross-reference and by the adversary probes the branch ran, not by
construction. two tz engines (ICU in the browser, the postgres tzdata) can also
disagree on a zone update.

prerequisites: none now. the pinned browser tests that required instant query
strings were throwaway and are deleted.

fix (design change 5.1): the wire carries local dates (`YYYY-MM-DD`, end
exclusive, start optional) and postgres resolves range and bucket edges in
`timeZone`. delete `zonedMidnight`; the pane keeps civil-date math only.

acceptance: no zone offset arithmetic in the web; for America/New_York
2026-03-08 and 2026-11-01, Pacific/Chatham 2026-04-05, America/Santiago
2026-09-06 and America/Havana 2025-11-02 the day view's range starts where its
first Day bucket starts.
