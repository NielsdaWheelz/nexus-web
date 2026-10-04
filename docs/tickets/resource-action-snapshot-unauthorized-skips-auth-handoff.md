# action snapshot unauthorized response skips auth handoff

status: deferred · origin: 2026-10-04 source audit · area: resource actions / web

`apps/web/src/lib/actions/resourceActionRuntime.tsx:71–88` fetches action snapshots. `resourceActionSnapshotCache.ts:187–204` catches a normalized 401, installs an error entry and resolves. the menu in `resourceActionRuntime.tsx:598–639` presents retry actions. the existing unauthenticated handoff runs for command and metadata failures, but this caught snapshot response reaches neither that handler nor the shell's unhandled-error path. this is a source-qualified gap, not a mounted reproduction.

impact: an authenticated menu with an expired session can remain on generic retry instead of entering the existing login return flow. prove the boundary with a mounted initial snapshot 401 and an explicit retry 401, isolated from other concurrent unauthorized requests. both should invoke the auth handoff with the current return target; transient read failures should still offer retry and same-system defects should still reach the render boundary.
