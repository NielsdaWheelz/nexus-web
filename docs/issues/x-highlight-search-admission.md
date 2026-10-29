# x highlight search admission

problem: global local search cannot admit immutable x highlight readings even when their parent media belongs to the workspace.

impact: saved x highlights disappear from resources search.

evidence: `node/authored/src/queries.ts:179` requires a `workspace_member` fact for the exact reading ref. `python/nexus/services/authored/scope.py:212` emits only media workspace membership; capture fragment readings at line 225 receive media membership at line 230 but no workspace membership. focused run 181747 omitted highlight `de2ae237-9759-4000-a5e8-74772319310a` while its full excerpt was locally available, the empty destination list admitted it to the default all library, so this is a real workspace exclusion.

fix: publish fragment workspace membership only through capture membership in workspace media. preserve unfiled-source exclusion. prove resolved with a filed parent source and a saved x highlight returned by resources search; retain a source-scope check and the unfiled negative case.

library scope has the same producer gap: `SEARCH_SCOPE_CTES.reading_targets` consumes direct `library_member` facts and does not compose library→media→capture. the producer now emits distinct fragment workspace and library membership through existing authorized media membership and readable capture membership. pending proof also includes a library-scoped x highlight/passage hit; no new consumer fallback exists.
