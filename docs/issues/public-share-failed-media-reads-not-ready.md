# a failed media's public link reads "still being prepared"

**problem**: the share gate answers `ProjectionNotReady` for every media that is not
text-ready, including one whose ingest failed for good. the Share overlay then says "The
public reader is still being prepared." and offers no link, for a media that will never be
prepared.

**impact**: misleading copy only; no link is created and nothing leaks.

**evidence**: `python/nexus/services/public_resource_sharing.py` `_load` (the
`is_text_document_ready` arm runs before any kind rule); atlas harness S10 (a `from-url`
ingest of a missing page: `creation_availability.link.reason == "ProjectionNotReady"`).

**resolved when**: a failed (not retrying) media answers `ProjectionUnsupported`, or the
overlay names the failure, and harness S10 asserts that copy. the gate may only loosen:
changing a reason string does not change which links open.
