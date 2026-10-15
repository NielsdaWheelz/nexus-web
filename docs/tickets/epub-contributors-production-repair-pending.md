# saved epub source-person matches remain unresolved

status: open; 235 retained source-person matches unresolved
origin: 2026-10-04 pr #482 closure; 2026-10-14 release r4 disposition
area: epub source contributors

tracking: [github #486](https://github.com/NielsdaWheelz/nexus-web/issues/486)

the 2026-10-14 restored-clone audit reconciled all original 244 owner-visible
saved epubs: five source-proved unchanged, 239 unresolved source-person matches,
zero proposals. the separately authorized other-viewer frankenstein produces
one [source-proved correction](legacy-epub-credit-outside-owner-scope.md).
no production credit apply has run.

in that historical clone, 238 unresolved items have no surviving `epub_opf` credit: 231 have only
`metadata_enrichment` credits and seven have no credits. one item,
`08d23b86-7042-4c72-bfe6-7faa5a696bee`, retains a source translator observation
but no exact creator correspondence. these are historical provenance facts,
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

the fresh 0283 audit on `702ba2b826` accounts for all 245 ids: 235 guarded
`unmatched_creator` skips, five unchanged, one frankenstein proposal and four
later deleted books, including `08d23b86`. no deleted source was fetched or
recreated. all 241 invoked items preserve their complete target state; shared
whole-database preservation remains pending the reader audit. root receipt:
`c-sources/contributor-audit-702-remaining240-v1/root-final-collection-v1/root-review.json`,
sha256 `e6c889851b805327eb1f8821ce06fed913bcb9d6a5fa9ec209a2c0c3822c55cd`.
independent review: `9f21b020aff17473185960d9de73ac4f7af16e5f90bc1710abcec28214ccb416`.

the [book-repair plan](../book-repair-plan.md) accepts evidenced unresolved
dispositions; proving every displayed credit correct is outside its scope.
retain the per-id source and current-credit evidence with each disposition.

next: retain the bounded audit's per-id dispositions. any later correction
needs independent source-person
correspondence and the [reviewed-preview fence](epub-contributor-apply-does-not-bind-preview.md).
do not broaden matching, split names or alter library membership.

acceptance: completing the bounded audit requires per-id accounting and
preserved state; it does not resolve the 235 remaining matches. resolving an
individual source-person mismatch requires proved identity, fenced correction
and exact changed-row evidence. preserve manual/unrelated credits, person
identities, reader/index/progress state and `metadata_enriched_at`.
