# 0251 needs a production loss inventory before release

status: open; release preflight unverified · origin: 2026-09-28 pr #413 (`0de14e39a`) · area: schema migration

2026-10-03 preparation: actual `0241` production archive restored locally;
owner-populated clone ran the complete transaction through `0250`, with its
loss inventory captured before `0251`. target `617baf70e`. private evidence:
`/private/tmp/nexus-metadata-release-uy48cjy2/actual-0241-loss-inventory.json`
and `pre-0251-loss-inventory.json`. these are restored-copy counts, not final
drained-release authorization or post-production repair receipts.

non-null losses include 711,008 evidence-span block pointers/offsets; 15,792
epub source rows' manifest/linear/media-type/order fields; 785 normalized credit
names; 473 source request ids, 573 run counts and 569 start times; 751 processing
attempt counts and 523 completion times; 502 atlas projection versions and
87 oracle resolution times. the pdf text-anchor table is empty. the single old
chat prompt is removed by `0246` before `0251`; original values remain in the
verified preliminary archive. owner review and the final drained backup/restore
remain required; this ticket stays open.

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
