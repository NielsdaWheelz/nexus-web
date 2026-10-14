# legacy epub source credit belongs to another viewer's saved scope

status: exact-item audit planned; read-only visibility diagnosis complete
origin: 2026-10-14 release r4 scope follow-up
area: contributors

`ce72f700-7416-44a5-ac80-9a2fb8d23717` is a ready-for-reading epub with a
successful ingestion attempt, publication generation 2 and 32 fragments. one
non-system library entry makes it visible to another viewer, not the release
owner. there is no failure, tombstone or teardown evidence; this is not an
orphaned or failed media item. it correctly lies outside the owner's 244-item
[r4 preview](epub-contributors-production-repair-pending.md).

it has one historical `epub_opf` author credit with null `raw_role`, outside
that owner scope. incorrect source credit is NOT PROVED. persisted source
metadata records 474,401 bytes and sha256
`dd7ec02d2c8db4162bf587aa09a692ed5394ead3dfb12d8cc14b449d89795a6a`;
this follow-up made no source object request; the verified other-viewer source
preview did not run. object existence and agreement with that persisted hash
remain unproved. no ownership, credit or other metadata was changed.

evidence: `release/attempts/58c7ecae6/r4-ce72-scope-followup-v1/manifest.json`,
sha256 `2ce17a11ed5ab13353f569d65938731ca8e27b3792e61bb506af1da3b9692676`.
the single read-only production query established viewer scope only; it does
not extend the guarded owner no-op into global saved-credit repair closure.

the owner deferred this preview from the usable release, then included this
exact item in the 2026-10-14 [book-repair plan](../book-repair-plan.md).
next: reverify its viewer/media scope and original source, then obtain the
planner's actual credit-row preview. preserve
current ownership and manual/unrelated credits. do not auto-file the media,
guess a person identity, broaden source guards or change unrelated metadata.

acceptance: a source-proved scoped disposition, followed only if needed by a
separately reviewed fenced correction with reader/person identities preserved.
a verified unchanged preview may establish that no credit repair is needed.
