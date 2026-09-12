# reader map merges arbitrarily distant destinations

status: open
origin: 2026-09-11 reader-map council audit
area: reader overview geometry and interaction

`apps/web/src/components/reader/ReaderDocumentMapOverviewRail.tsx:590` compares each marker only with its immediate predecessor, joining them when their projected separation is below 24px. the resulting group is rendered once at its median (`:604`). this is transitive: on a 600px track, markers every 0.03 document units are 18px apart and a chain can collapse nearly the entire document into one node. evidence markers can bridge otherwise separate chapters. canonical section offsets can be correct while the visible chapter geometry is wrong. the existing browser proof covers only two adjacent destinations (`ReaderDocumentMapOverviewRail.browser.test.tsx:9`).

prerequisites: specify how exact section positions coexist with finite pointer targets and dense evidence.

proposed fix: retain every structural boundary at its exact coordinate; separate structural rendering from evidence density and pointer-hit presentation. any evidence aggregation must have a bounded spatial extent and preserve individual destinations in an accessible detail view. do not move chapter coordinates to cluster medians.

acceptance: a dense chain spanning the document does not become one node; inserting highlights cannot move or merge chapter boundaries; a 1:3:6 section fixture has 1:3:6 geometric spans; every coincident or dense destination remains reachable with pointer and keyboard.
