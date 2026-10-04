# atlas timestamp deletion needs release review

status: open; production release preflight
origin: 2026-10-04 metadata/current-main composition, `8c9b7d332`
area: atlas / migration 0254

`0254_drop_atlas_position_timestamp.py` irreversibly drops
`media_atlas_positions.computed_at`. actual restored `0241` inventory contains
502 rows and 502 non-null timestamps. private evidence:
`/private/tmp/nexus-metadata-release-uy48cjy2/`; the preliminary original archive
retains those values. this is declared unused data, not an inferred empty column.

current frozen `bcb86e0204ef2ea347a8836a9e5d48f031d09134` is locally qualified:
the actual controlled owner-populated `0241→0257` proof removes only
`computed_at` and retains every atlas row identity and all remaining fields by
exact row digest. receipt `0257-metadata-restored-cutover.receipt.json`, sha256
prefix `b0b50e9f192f`; timestamp loss inventory
`0257-actual-0241-loss-inventory.json` is in the same private directory.
this does not approve the production loss or qualify the final release backup.

prerequisites: review the intended loss, take the fresh drained source-bound
backup and actually restore/qualify those exact bytes. the composed migration
must retain every atlas row and remaining field. no provider or production write
qualifies this preparation.

acceptance: recorded loss approval and final backup/restore, exact aligned
production chain and retained atlas data. delete after actual release receipts.
