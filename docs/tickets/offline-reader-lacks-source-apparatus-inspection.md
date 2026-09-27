# downloaded reader lacks the evidence pane

status: open · origin: 2026-09-26 source-note implementation · area: android offline reading

downloaded text and pdf readers offer the document map, but do not package or
render the hosted evidence pane's source-note bodies. `apps/web/src/offline-reading/OfflineDocumentReader.tsx:735`
opens its document map; no source-target or evidence projection is consumed in
`apps/web/src/offline-reading/`. the source-note plan excludes offline apparatus
packaging, so readers cannot inspect a full source note while disconnected.

prerequisite: define the offline package's evidence/content contract and its
size limit. add the same read-only source-note presentation through the offline
document map, preserving provenance and unavailable states. acceptance: a
downloaded annotated epub and supported pdf expose the same source targets and
body content offline, with no network request or invented content.
