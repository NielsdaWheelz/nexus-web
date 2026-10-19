# dead metadata jobs await reviewed production retirement

status: open; production release/repair gate
origin: 2026-09-27 read-only production census, deployed `7dc68929b4d5ddfd77eb1a50228d477fa0148b5d`
area: migration 0246 / media enrichment

fresh census, 2026-10-03 22:56:47 UTC: 52 outcome-null media enrichment parents,
56 dead metadata jobs (52 `Uncertain` journals, four without a journal), 56 media,
53 credits. these replace the historical 41-job count; they are not additive.
zero tool positions does not prove native completion or absence of effects.
exact rows/hashes and ownership:
[reset ticket](model-history-cutover-blocked-by-uncertain-work.md).

current frozen `bcb86e020` qualifies exact original-job retirement and complete
`0241→0257` on an actual controlled owner-populated restore, retaining domain
facts and independent completed writes (`0257-metadata-restored-cutover.receipt.json`,
`b0b50e9f192f`). the earlier `617baf70e/0256` proof stays historical.
no original production job was settled, replayed or deleted.
eight affected saved lewis units still have null first-publication dates;
`production-disposition-preview.json` is a private review preview, not authority.

prerequisites: final drained census, verified R2 archive and actual restore,
reviewed exact IDs and separately authorized aligned release under
`docs/metadata-enrichment-plan.md` §9 at `407fcc735`.
after archival retirement, create ordinary NEW metadata jobs for selected saved
items; never redispatch an uncertain original or rewrite dates unconditionally.

acceptance: actual release records exact old-job disposition while preserving
original uncertainty in its archive; new jobs publish correct item-specific
first dates and refresh open views. [saved-date repair](metadata-book-date-counts-serialization.md)
and [saved-epub repair](epub-contributors-production-repair-pending.md) own their
production acceptance. inspect skips and failures; close only with production receipts.
