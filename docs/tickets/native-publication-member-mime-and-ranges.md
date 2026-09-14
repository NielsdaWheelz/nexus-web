# native retained members lose their verified media type

- status: open; assigned to native schema-2 adapter integration
- origin: 2026-09-13 bounded-workspace root review
- area: offline reading lease / local request router

`apps/android/app/src/main/java/app/nexus/android/offline/readingweb/OfflineReadingRequestRouter.kt`
`serveEntry` derives content type and byte-range eligibility from the filename
extension. schema-2 retained asset keys are extensionless. a retained PDF loses
its application/pdf and range contract; captured images become octet-stream.

carry the verified manifest member media_type through the existing selected
lease entry contract. serve exact verified metadata and preserve PDF range
semantics, account/lease authorization and local-only routing. do not infer a
format from a new alias or sniff unverified source bytes.

acceptance: an actual verified schema-2 extensionless PDF supports its correct
MIME and valid/invalid range requests; extensionless image/font members retain
their declared MIME. unknown or unauthorized members remain unavailable. the
proof fails when filename-extension inference is restored.
