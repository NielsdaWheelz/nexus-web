# frankenstein source role correction needs a reviewed-preview fence

status: source and existing identity proved; fenced correction pending
origin: 2026-10-14 release r4 scope follow-up
area: contributors

`ce72f700-7416-44a5-ac80-9a2fb8d23717` is a ready-for-reading epub with a
successful ingestion attempt, publication generation 2 and 32 fragments. one
non-system library entry makes it visible to another viewer, not the release
owner. there is no failure, tombstone or teardown evidence; this is not an
orphaned or failed media item. it correctly lies outside the owner's 244-item
[r4 preview](epub-contributors-production-repair-pending.md).

the restored-clone audit verified the original 474,401-byte epub and sha256
`dd7ec02d2c8db4162bf587aa09a692ed5394ead3dfb12d8cc14b449d89795a6a`;
its sole creator explicitly has role `aut`. the planner matches the existing
author/person and proposes only `raw_role: null → "aut"`. this restores source
role metadata; it does not change the displayed author.

credit `bf9b3748-9de0-44f1-bd5b-1bad8c5de044`, person
`83550d2e-74f3-49b3-bf74-fc838650cb03`, name, handle, author role, `epub_opf`
provenance and ordinal zero remain unchanged. the exact observed-spelling alias
already exists; no person, key or alias addition is proposed. the read-only
whole-clone proof passed; actual apply and its preservation proof remain pending.

private evidence: `book-repair/c-sources/frankenstein-proposal-review.json`,
sha256 `62769ca7ce5451682e75184285747ad1d36638c94634258f754e56c810500b2c`;
independent source review `a-maintenance/frankenstein-source-review.json`,
sha256 `7925a8ee64c4e9ad528f875592a39a9adb60c03788a80d2c32cca9ca101e7d6a`;
alias snapshot `c-sources/frankenstein-alias-v2`, sha256
`a742efe4e49053d09f8f4b1dfc54721198ebd6259dafb5177b37d9ee561876df`.

next: implement and qualify the [preview fence](epub-contributor-apply-does-not-bind-preview.md),
then rehearse this exact correction before fresh production inspection/apply.
preserve viewer `579543d7-64ec-4282-9f1b-7a445ebf672a`, ownership and library;
do not auto-file the media or broaden matching.

acceptance: the reviewed role correction applies once, fresh preview is
unchanged and stale preview refuses. all other credit/person, reader, index,
progress and metadata timestamp state matches baseline; live consumers keep
the existing author presentation. no production mutation has run.
