status: open
origin: 2026-09-25 notes writing cutover
area: browser draft migration

the writing branch removes the old annotation, resource-surface, and daily
draft readers. existing target-browser `nexus.noteBodyDraft:*`,
`nexus.resourceSurface:*`, and `nexus.dailyDraft:*` records need a checkpoint.
releasing without a target-profile census
could hide unsaved writing; the bytes remain untouched in browser storage.

read-only host scan on 2026-09-26 found zero matching files among 11 readable
chrome local-storage files and 36 readable webkit files. no brave, edge, or
safari local-storage files were visible. this is file evidence, not a census of
the active target browser profile or android webview.

on 2026-09-27, a read-only sqlite inspection of the active firefox profile at
`~/Library/Application Support/Firefox/Profiles/pbgmf1p8.default-release/storage/default/https+++nexus.nielseriknandal.com/ls/data.sqlite`
found two total keys and zero under each old draft prefix. an open tab could
still hold unflushed work. the installed android release is nondebuggable with
backup disabled, so adb cannot read its webview store; its counts remain
unknown. a signed, same-package interim export is implemented on isolated
branch `feature/android-old-notes-checkpoint` at `3b2615dc`; its signed
artifact is verified, but physical same-profile readback and cutover are not.

prerequisite: access to the user's target browser profiles before release.
count old draft keys without changing them; export unresolved payloads and
confirm their owners, then convert actual pending work or explicitly retain
its export before release. repeat the desktop count after tabs are quiescent;
verify the android export bytes and digest before switching hosted notes code.

acceptance: target profiles have no unaccounted pending drafts, exports are
readable, and the cutover has one current journal decoder with no legacy path.
