status: open
origin: 2026-09-25 notes writing cutover
area: browser draft migration

the writing branch removes the old annotation, resource-surface, and daily
draft readers. existing target-browser `nexus.noteBodyDraft:*`,
`nexus.resourceSurface:*`, and `nexus.dailyDraft:*` records have not been
counted or exported. releasing the branch without a target-browser census
could hide unsaved writing; the bytes remain untouched in browser storage.

read-only host scan on 2026-09-26 found zero matching files among 11 readable
chrome local-storage files and 36 readable webkit files. no brave, edge, or
safari local-storage files were visible. this is file evidence, not a census of
the active target browser profile or android webview.

prerequisite: access to the user's target browser profiles before release.
count old draft keys without changing them; export unresolved payloads and
confirm their owners, then convert actual pending work or explicitly retain
its export before merging this branch.

acceptance: target profiles have no unaccounted pending drafts, exports are
readable, and the cutover has one current journal decoder with no legacy path.
