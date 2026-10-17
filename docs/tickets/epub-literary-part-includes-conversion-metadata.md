# a literary part absorbs conversion metadata

status: open; new part scope independently confirmed unsafe
origin: 2026-10-15 book-repair retained-content review, operator `150328b65`
area: epub reading-division boundaries

media `39121faf-e147-4f49-9edc-e70c8a832a4b` has an explicit `Part III`
heading at `82:0`. its publisher extent is unknown; the same-point heading
currently ends at `83:0`. the candidate retires that heading and gives the
part an end at `112:0`, crossing the separate `OEBPS/fb2info.xhtml` document
at `111:0`.

that complete 213-character document is conversion metadata: document id,
version, creation date, software name, document-author and source-url headings.
it explicitly names fiction book designer. the next document describes the
fb2epub converter. these are not content of the literary part. the last
chapter's heading already included the metadata, so its transferred tail is
an inherited defect; the part's asserted scope is new. stored text and
destinations remain intact. unrelated proposal fields are unadjudicated.

`python/nexus/services/reader_structure.py:103–126` derives ends from admitted
ancestry and source-container bounds. the conversion section remains below
the last chapter, allowing the new part scope to include it. establish the
conversion material's distinct role and boundary at the epub structure owner
before deriving literary ranges. do not replace this with a universal file
boundary or heading-rank rule, or infer an ideal chapter end from this finding.

private source/full-projection evidence:
`c-sources/navigation-conversion-tails-review-v1.json`, sha256
`03d5ca6004623596e5d789e0317f314a9931ba94ee6fc263ea6e99e198da22fd`;
helper `6313132af512cbd826869977ea9eb42e7ce0aaa6852bf22c8a93c1e5bfa78f68`
passed once with empty stderr. source sha256
`741ad7e0d50f70eb952337e798a2879a6e3cd63a385bfd1a111ed244a220c3c6`;
snapshot `65962cf52908c0b93068e43ba69743a8f0143219393b59f44109ae5c45a26516`;
proposal `5a0af5d985924f94b1954b93eedc743bebc7568411feb09b953132f7f40e797f`.
exact retained html/text and full-row hashes are bound. original navigation,
title-image semantics, apply and reader consumers were not run.
independent source and complete-projection review:
`a-maintenance/conversion-tail-independent-review.json`, sha256
`4c8c1810c1c89082885a3be38cfe875174965178d64bb905ec555ddb618be731`.

acceptance: preserve the conversion material and its destination while proving
the literary part's independent scope excludes it. distinguish the new part
extent from the inherited chapter defect; review the complete correction and
normal reader behavior before applying this book.
