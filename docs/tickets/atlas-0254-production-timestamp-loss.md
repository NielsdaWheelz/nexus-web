# atlas timestamp deletion needs release review

status: open; production release preflight
origin: 2026-10-04 metadata/current-main composition, `8c9b7d332`
area: atlas / migration 0254

`0254_drop_atlas_position_timestamp.py` irreversibly drops
`media_atlas_positions.computed_at`. actual restored `0241` inventory contains
502 rows and 502 non-null timestamps. private evidence:
`/private/tmp/nexus-metadata-release-uy48cjy2/`; the preliminary original archive
retains those values. this is declared unused data, not an inferred empty column.

prerequisites: review the intended loss, take the fresh drained source-bound
backup and actually restore/qualify those exact bytes. the composed migration
must retain every atlas row and remaining field. no provider or production write
qualifies this preparation.

acceptance: recorded loss approval and final backup/restore, exact aligned
production chain and retained atlas data. delete after actual release receipts.
