# Public PDF bytes stream through the api: keep, or hand out signed urls

status: deferred · awaiting owner decision · origin: 2026-09-28 resource-sharing reauthoring (size/resource-sharing, finding F17) · area: resource sharing / public reader

`GET /api/public/resource-share/file` streams the shared PDF from storage
through FastAPI (`api/routes/public_resource_shares.py`), reauthorizing the
`X-Nexus-Share-Token` header on every Range request. a signed storage url would
move the bytes off the api, but it outlives revocation for its lifetime, and it
breaks two documented properties (`docs/modules/resource-sharing.md`): every
subresource reauthorizes the token, and no raw storage path or url is emitted.

impact: api bandwidth and a held worker per open PDF range stream. revocation is
immediate and storage stays private.

recommendation: keep streaming. revisit only if measured api egress or latency
from public PDFs becomes a problem; a signed url would then need a lifetime
shorter than the tolerated revocation delay.

resolved when: the owner records keep (delete this ticket) or signed urls with
a stated revocation window.
