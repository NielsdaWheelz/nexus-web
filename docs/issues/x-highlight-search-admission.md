# x highlight search admission

problem: global local search cannot admit immutable x highlight readings even when their parent media belongs to the workspace.

impact: saved x highlights disappear from resources search.

evidence: `node/authored/src/queries.ts:179` requires a `workspace_member` fact for the exact reading ref. `python/nexus/services/authored/scope.py:212` emits only media workspace membership; capture fragment readings at line 225 receive media membership at line 230 but no workspace membership. focused run 181747 omitted highlight `de2ae237-9759-4000-a5e8-74772319310a` while its full excerpt was locally available, though that fixture also used unfiled source destinations and alone does not establish wrongful exclusion.

fix: publish fragment workspace membership only through capture membership in workspace media. preserve unfiled-source exclusion. prove resolved with a filed parent source and a saved x highlight returned by resources search; retain a source-scope check and the unfiled negative case.
