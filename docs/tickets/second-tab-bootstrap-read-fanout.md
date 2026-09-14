# workspace bootstrap admits every restored pane read together

- status: open
- origin: 2026-09-13 memory investigation; deployed sha `7e8fd48244b3b436965037738e05785bb4931be1`, local sha `7fa89b88c8342bca9edfb46a6d20053c49555fb2`
- area: workspace bootstrap request admission

`apps/web/src/lib/workspace/bootstrap.server.ts:231–242` selects every
restored visible pane and starts every seed with `Promise.all`. the file
is identical in both shas and has no viewport restriction. mobile renders
only the active pane (`WorkspaceHost.tsx`, deployed line 1589), yet its
bootstrap can still seed all 12 allowed panes (`workspace/schema.ts:28`).
the author seed starts contributor detail and works concurrently
(`paneResourceLoaders.ts`, deployed lines 200–211), with a works limit of
100 (`api/resource.ts`, deployed line 209). twelve distinct restored
author panes therefore admit up to 24 seed reads together, after the
account/profile/session wave. this is a source-level fanout bound, not
the measured allocation that caused the reported api out-of-memory kills.

failed url seeds are immediately eligible again in wave two (lines
219–228); server seeds use a 500 ms request deadline. failed seeds may
then be fetched again by the client. client cancellation alone does not
prove that earlier backend work has stopped.

prerequisites: measure per-route allocation/response extent and backend
concurrency under the actual memory limit; retain the mandatory bootstrap
account and reader-profile contracts.

proposed fix: give seed reads explicit admission under that measured
capacity budget, prioritize the active pane, and defer panes the current
composition does not need. deduplicate live resource work across seed and
client ownership where the boundary permits it; make fallback attempts
respect one operation budget. do not change the twelve-pane product limit
as a substitute for bounding execution.

acceptance: restore a mixed twelve-pane workspace on mobile and desktop
under a controlled slow backend; active content is prioritized, inactive
mobile content creates no eager body workload, admitted reads stay within
the measured budget, and timeout/recovery does not multiply abandoned work.
verify the production memory envelope and run proof through `./scripts/test`.
