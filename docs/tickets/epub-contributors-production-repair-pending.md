# saved epub source-person matches remain unresolved

status: bounded source audit verified; 239 source-person matches unresolved
origin: 2026-10-04 pr #482 closure; 2026-10-14 release r4 disposition
area: epub source contributors

tracking: [github #486](https://github.com/NielsdaWheelz/nexus-web/issues/486)

the 2026-10-14 restored-clone audit reconciled all original 244 owner-visible
saved epubs: five source-proved unchanged, 239 unresolved source-person matches,
zero proposals. the separately authorized other-viewer frankenstein produces
one [source-proved correction](legacy-epub-credit-outside-owner-scope.md).
no credit apply has run.

238 unresolved items have no surviving `epub_opf` credit: 231 have only
`metadata_enrichment` credits and seven have no credits. one item,
`08d23b86-7042-4c72-bfe6-7faa5a696bee`, retains a source translator observation
but no exact creator correspondence. these are current provenance facts,
not evidence of how the state arose or whether displayed credits are correct.
the repair must not guess person identities to manufacture eligibility.

private evidence: `book-repair/c-sources/audit-reconciled-v2.json`, sha256
`ecd1e82bb4576d704774f27af0493774bd8e28a3a06dc0fa9c40fd4ed253a868`.
all 245 requested ids and 5,396 artifact hashes reconcile; each inspected
item's before/after state agrees. database `nexus:7696659211119792166`, schema
0278, operator source `2e4328dd3`. the final empty-selection snapshot matches
the initial snapshot byte-for-byte across all 96 public tables and 3,273,526 rows:
sha256 `c79dbbed1913d9c35b00fde7c6c5ea481568b5e955bbe5cd97059d7815f16be7`.
receipt: `b-reader/global-after-v1/reviewed-receipt.json`, sha256
`337696bc19b165fded2f298c17601ec61b6cb969e4c795677d6dfbe31ada4e6f`.
the failed initial serializer attempt remains failed, not a book disposition.

the [book-repair plan](../book-repair-plan.md) accepts evidenced unresolved
dispositions; proving every displayed credit correct is outside its scope.
retain the per-id source and current-credit evidence with each disposition.

next: retain the bounded audit's per-id dispositions. any later correction
needs independent source-person
correspondence and the [reviewed-preview fence](epub-contributor-apply-does-not-bind-preview.md).
do not broaden matching, split names or alter library membership.

acceptance: complete per-id accounting and preserved state for the bounded
audit. resolving an individual source-person mismatch requires proved identity,
fenced correction and exact changed-row evidence. preserve manual/unrelated
credits, person identities, reader/index/progress state and `metadata_enriched_at`.
