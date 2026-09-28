# 0251 needs a production loss inventory before release

status: open; release preflight unverified · origin: 2026-09-28 pr #413 (`0de14e39a`) · area: schema migration

`migrations/alembic/versions/0251_drop_write_only_schema.py:26-80`
irreversibly drops `highlight_pdf_text_anchors`, 39 columns including the
chat prompt manifest, and stored reindex `request_id` values. pr #413 proved
the migration and a dead reindex job on disposable data, but did not record
what the current production database would lose. the deployed api reported
database `0241` on 2026-09-28; some drop targets may be introduced by the
intervening migrations. the verified release backup is the only recovery copy.

prerequisite: a read-only production snapshot and a restored copy advanced to
`0250`. inventory row/non-null counts for the drop targets that exist at each
stage; review any retained prompt or anchor data before accepting deletion.
then run `0251` on that copy and verify the expected head and dead reindex
replay. do not infer safety from the absence of repository readers alone.

acceptance: the loss inventory and owner decision are recorded, the backup is
verified, the exact release migrates to `0251`, and post-migration reads and
reindex repair pass. delete this ticket after those observations.
