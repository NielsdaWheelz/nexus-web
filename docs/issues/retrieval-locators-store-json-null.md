# nine historical retrieval locators store json null instead of sql null

the verified `8a67e218a` dump (0292) contains nine `message_retrievals.locator`
values equal to `'null'::jsonb`, among 46 retrieval rows. the repaired restored
candidate at 0302 retains exactly those nine ids and creates no new json-null
locator. input classification comes directly from the dump's copy values, which
distinguish `null` from sql-null `\N`; a `to_jsonb(row)` snapshot cannot do that.

impact: the substrate's c7 preflight fails. python decodes both forms as `None`,
but sql `IS NULL` excludes these nine rows. #711 corrected future orm writes with
`JSONB(none_as_null=True)`; it did not convert historical values. 0293 preserves
its intended data effects and should not acquire an unrelated repair.

evidence: `nexus-web-campaign-artifacts/2026-10-20/migration-0293-preservation/`
`retrieval-locator-lineage.json` and `substrate-census.json`. the affected-id set
sha256 is `4eb5e54175bb8b2feeaf1162e1e70fc167afe5a4ec5878f43cfa6bbffc116e6d`.

resolve in a narrowly scoped forward data migration after the canonical head:
set `locator=NULL` only where `locator='null'::jsonb`. preserve every retrieval
id, quote, attribution and other field. rehearse the conversion on the verified
backup, require c7 to return zero, and verify non-null locator values unchanged.
production is unchanged; this remains a substrate release prerequisite.
