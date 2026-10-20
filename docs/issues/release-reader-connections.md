# reader connections release

status: implementation complete; paired release and production smoke pending.

the document-map evidence response hard-cuts to direct resource roots. pair the
web and api; regenerate wire types and reject older clients through X-Nexus-Wire.
`7b7d9f82a` was deployed to production on 2026-10-19 with wire 12; this first
breaking change bumps `WIRE_REVISION` to 13. later breaking changes before the
next release ride 13.
coordinate the connection-actions cutover; no reader data migration or corpus
rewrite is required.

after pairing, inspect the reported sword & citadel book through normal
authenticated reads: direct chat once at whole-document root; chats reached only
through highlights/citations remain nested; filters/counts/marks are direct-only.
check native annotations, stale-location grouping and exact relationship actions
on disposable records. do not unlink or annotate the user's real book as a probe.

resolved when: the paired release and affected live smoke pass, with actual
version/wire and remaining limits in the release pr. temporary test cleanup alone
is not production acceptance.
