# finish quiet firefox recovery qualification

browser recovery's api/storage/worker, migration and boundary proofs pass, but
the complete native firefox interaction remains unqualified. do not present
partial native observations as a passing journey.

evidence: private lab `20261028-105613-7399be621e77` installed the real extension,
completed permission/identity interaction and confirmed capture onto the original
media `7bbc7b22-b4ba-4602-9ac3-232ab9619ea8`. inspector navigation and readable
publication were not asserted successfully. a later live check found duplicate
chooser elements from identical sibling keys; the fix passes static checks but
still needs browser qualification.

the owner prohibited unapproved desktop windows, activation and native desktop
input on 2026-10-28. the last owned diagnostic runtime
`20261028-110418-054dab3f0caf` was stopped and cleaned up. migrate the temporary
driver to the shared `python/scripts/lab_firefox.py` helper under development in
the quiet-browser-verification worktree. no headed retry is authorized.

resolved when real headless firefox verifies the source link, popup selection
and preview, permission/identity transition, preserved import and published
reader, keyboard/focus behavior, failed lookup refusal, frozen response-loss
replay, stop-checking without deletion and account fencing. keep temporary cases
until those observations pass; then delete them. if a specific observation
requires desktop access, identify why and obtain scoped owner approval first.
