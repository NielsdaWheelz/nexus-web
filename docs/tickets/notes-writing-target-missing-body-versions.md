status: open
origin: 2026-09-25 notes writing cutover
area: note body versions

new highlight and link note projections require canonical `body` and
`links` lane versions. newly created notes have both, but the target
database has not been checked for preexisting `note_blocks` missing either
`resource_versions` row. such notes fail the strict writing client decoder.

prerequisite: read-only target database access. count owned note blocks missing
`body` or `links` rows independently for their `note_block:<id>` ref;
repair affected rows with a data-aware migration if needed.

acceptance: both missing-lane counts are zero and existing annotation notes
open with real body and links versions after the cutover.
