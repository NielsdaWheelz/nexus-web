# downloaded reader lacks the evidence pane

status: open · origin: 2026-09-26 source-note implementation · area: android offline reading

downloaded text and pdf readers offer the document map, but do not package or
render the hosted evidence pane's source-target projection.
`apps/web/src/offline-reading/OfflineDocumentReader.tsx:765–779` renders only
navigation detail. pr #393 verified that an authored pillow footnote can open
through its retained document link without network and return within 0.4 px.
that source-document journey does not provide aligned evidence inspection;
the note experience varies with the publisher's retained links.

prerequisite: define the offline package's evidence/content contract and size
limit. add the same read-only source-note presentation through the offline
document map, preserving provenance and unavailable states. acceptance: a
downloaded annotated epub and supported pdf expose aligned source targets and
body content offline, with no network request or invented content.
