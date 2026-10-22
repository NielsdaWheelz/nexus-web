# reader connections release

status: implementation complete; paired release and production smoke pending.

the document-map evidence response hard-cuts to direct resource roots. pair the
web and api; regenerate wire types and reject older clients through X-Nexus-Wire.
production still runs `8a67e218a` at wire 11 (host checked 2026-10-21/22; the
10-19 `d6f04890c` record never reached it); 12 and this change's 13 are both unreleased.
this breaking change bumps `WIRE_REVISION` to 13. later breaking changes before the
next release ride 13.
coordinate the connection-actions cutover; no reader data migration or corpus
rewrite is required.

after pairing, inspect the reported sword & citadel book through normal
authenticated reads: direct chat once at whole-document root; chats reached only
through highlights/citations remain nested; filters/counts/marks are direct-only.
check native annotations, stale-location grouping and exact relationship actions
on disposable records. do not unlink or annotate the user's real book as a probe.
check view radios and sidebar scrolling with expanded placed roots and both
bottom groups: preserve reading position, visible occurrence and pending drafts.
remove a disposable link/highlight during its note's first save: target refusal
must retain the unsaved note uuid/body. this timing case needs live verification
after composing the note-lifecycle changes; acknowledged-note deletion remains
a separate outcome.

resolved when: the paired release and affected live smoke pass, with actual
version/wire and remaining limits in the release pr. temporary test cleanup alone
is not production acceptance.
