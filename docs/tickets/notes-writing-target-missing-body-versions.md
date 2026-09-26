status: open
origin: 2026-09-25 notes writing cutover
area: note body versions

new highlight and link note projections require the canonical body lane
version. newly created notes have one, but the target database has not been
checked for preexisting `note_blocks` without a matching `resource_versions`
row. such notes would be unreadable by the strict writing client.

prerequisite: read-only target database access. count owned note blocks with
no `resource_versions` row for their `note_block:<id>` ref and `body` lane;
repair affected rows with a data-aware migration if needed.

acceptance: the count is zero and existing annotation notes open with a real
body version after the cutover.
