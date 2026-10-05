# unused library entry export aliases

status: deferred
origin: 2026-10-05 independent source audit at `031c3c95de81f25306b4e17fd656d9eeaf72218c`
area: web / library entry types

`apps/web/src/lib/libraries/entryListItem.ts:41–42` exports
`LibraryPodcastSubscriptionValue` and `LibraryEntryPlacement`; repository
search finds only their definitions. these two web aliases obscure the live
generated owners. native `LibraryEntryPlacementOut` remains used.

delete only the unused aliases in a later library slice. resolution requires
the fresh caller census and sole static gate; do not retire native output or
generated schemas on this evidence.
