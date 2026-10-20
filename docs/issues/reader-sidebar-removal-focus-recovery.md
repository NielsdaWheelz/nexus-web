# global highlight delete changes reader visit before removal

an action launched from a connections row can navigate to the highlight before deleting it. this remounts the sidebar and loses the invoking row's attention ownership; keyboard focus eventually lands on body. this is a global resource-action navigation question, not evidence that same-visit row-removal recovery fails.

observed 2026-10-19 on `codex/reader-sidebar-view-20261019`, real isolated browser/web/api/database. pause only the owned api; select a highlight row's settled `Delete highlight` action and accept native confirmation. before the response, url changed from another highlight fragment to the deleted highlight fragment and radio `name` changed from `_r_63_` to `_r_bp_`. row still existed; focus was the new connections tab. earlier removals settled with focus on body.

the existing contract in `docs/modules/workspace.md` routes highlight deletion
through its activation href and a visit-addressed entry. the implementation is
`lib/actions/project.tsx` → `useAnnotationVerbs.ts` under the web source tree.
changing that policy belongs to global resource actions, not a sidebar-specific
delete command or a stale focus-history workaround.

investigate whether delete should require resource navigation. prove resolved with an explicit global-action focus contract across that visit transition. verify local same-visit unlink separately. no mocks or auth bypass were used.
