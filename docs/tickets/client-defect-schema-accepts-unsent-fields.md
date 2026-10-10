# client-defect request schema accepts fields the web never sends

status: open · origin: 2026-10-09 web dead-code sweep (cleanup/web-dead-code, claude session) · area: telemetry / client defects

the sweep deleted `withClientDefectContext`, the only source of `Admission` and
`Read` phases and of `command_id` / `run_id`. the web's sole producer,
`apps/web/src/lib/telemetry/clientDefects.ts` (called from
`PaneRouteErrorBoundary`), now always sends `phase: "Render"` with both ids
absent. no other client posts to `/telemetry/client-defects`.

`python/nexus/schemas/telemetry.py:20-22` still accepts all three phases and
both ids, so the wire contract is wider than any producer. the web type was
narrowed to `phase: "Render"`; it must keep sending absent ids while python
requires the keys.

fix: drop `command_id` and `run_id` and narrow `phase` (or drop it) in
`ClientDefectRequest` and the route log fields; regenerate the wire; remove the
two absent ids from the web report.

resolved when: `git grep -n -E 'command_id|run_id|"Admission"' -- python/nexus/schemas/telemetry.py python/nexus/api/routes/telemetry.py apps/web/src/lib/telemetry`
is empty.
