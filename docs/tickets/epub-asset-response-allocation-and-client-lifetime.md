# epub asset response allocation and client lifetime

status: open · origin: 2026-09-15 restoration memory investigation · area: epub assets · oi-125

## evidence

source `6baccaee9c053b10f46fb5e270e73f5bc12b5026`:
`python/nexus/api/routes/media_assets.py:65-90` serves epub assets outside the
external-image fetch limiter. `epub_assets.py:156` loads the whole media row,
including undeferred `plain_text`, for kind/readiness metadata.
`epub_assets.py:120-123` creates a storage client per request and reads the
complete object. `storage/read.py:17-26` retains chunks before joining them,
temporarily retaining both chunks and the resulting contiguous body.
`storage/client.py:400-429` constructs a new boto3 client without an explicit
request close or shared client lifetime.

persisted object size is checked, but this path has no aggregate response-byte
budget. these allocations and lifetime choices are source-proven; a client
leak is not. no epub asset requests were present near the observed oi-116
production oom, so this ticket does not attribute that incident to epub assets.

## next action and acceptance

measure concurrent representative epub assets, including actual object sizes
and storage-client overhead. narrow the media metadata read and establish
explicit client lifetime and bounded response allocation without weakening
size integrity, access checks or svg csp. verify the owning path on the devbox
within the existing api limit; do not infer completion from external-image
proxy measurements.
