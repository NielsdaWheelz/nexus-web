# consumption-stats is 18% over its line target

status: open · origin: 2026-09-28, size/consumption-stats reauthoring · area: consumption / stats pane / size program

the slice landed at 5,430 owned lines against the design's 4,588 (10,456 before,
−48%). python is 2,995 against 2,616, web 2,435 against 1,972. over budget by
more than ~15%: `StatsPaneBody.tsx` 974/740, `StatsPaneBody.module.css` 285/220,
`statsPeriod.ts` 139/110, `ActivityHealth.tsx` 75/60,
`schemas/consumption_activity.py` 293/200, `routes/consumption_activity.py`
106/85, `services/consumption/handles.py` 67/50. slightly over:
`activityRuntime.ts` 287/240, `activityRecorder.ts` 215/180, `activityOutbox.ts`
188/160. review found no dead code or duplication behind the overage.

part of it is wire the design deleted and throwaway live tests (now gone) kept:
- the `Week` bucket: `stats.py:35` accepts it; no client sends it
  (`statsPeriod.ts:21` maps week to `Day`; no android, extension or node caller).
- `totals.recordedActiveMs` (`schemas/consumption_activity.py:177`,
  `stats.py:370`): the pane reads it once (`StatsPaneBody.tsx:909`) for the empty
  state, which `activeMs == 0 && activeExclusions.length == 0` decides equally.
- two session-page shapes: `GET /consumption/sessions` returns
  `ActivitySessionPageOut {sessions, nextCursor}` (`:165`), the stats payload
  `ActivitySessionsOut {rows, nextCursor}` (`:170`).
- instant range edges, which keep `zonedMidnight` (~28 lines) in the client; see
  [stats-local-midnight-rule-has-two-owners](stats-local-midnight-rule-has-two-owners.md).

prerequisites: none. only the stats pane reads these routes, and web and api
release together.

fix: drop `Week`, `recordedActiveMs` and `ActivitySessionPageOut` (sessions
returns `ActivitySessionsOut`); then restructure `StatsPaneBody.tsx` and the egress
models toward the budget rather than packing lines.

acceptance: owned lines at or under ~4,600, the Stats pane unchanged to a
reader (timeline, heatmap, hours, works, sessions, exclusions), `./scripts/test`
green.
