status: open
origin: 2026-09-25 notes writing cutover
area: stored note bodies

the isolated development database has no stored link hrefs (recursive
`jsonb_path_query` census, 2026-09-25). the target database has not been
examined. older note bodies could contain unsafe href marks written before the
new validator. frontend rendering now makes unsafe marks inert, but stored
content needs a data-aware census before release.

prerequisite: read-only access to the target `note_blocks` table. inspect all
`$.**.marks[*].attrs.href` values against the new link policy. if any are
unsafe, migrate only those marks, preserve text, and bump body versions.

acceptance: target census receipt identifies every unsafe href; either count
is zero or repaired rows pass the same census and retain their text.
