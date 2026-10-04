# Are nxps1_/nxpa1_ handles durable, or scoped to one open tab

status: deferred · awaiting owner decision · origin: 2026-09-28 resource-sharing reauthoring (size/resource-sharing, finding F38) · area: resource sharing / sealed handles

EPUB section and image handles (`nxps1_…`, `nxpa1_…`) are minted inside the one
`GET /api/public/resource-share` document and used only by the tab that loaded
it; unlike `/s#share=nxshr1_…` links they are never handed out. the reauthoring
kept their codec byte-identical anyway (the slice's hazard list names them
live): a double-sha256 EPUB revision digest over the attempt and resource rows
plus a per-grant HMAC (`services/public_resource_sharing.py:_epub_digest`,
`_tag`, `_seal`, `_unseal`, about 65 lines). this PR changes the section
response shape, so tabs open across its deploy break regardless.

impact: ~65 lines and a frozen digest layout whose only benefit is surviving a
deploy in an already open tab.

options: (a) keep them durable; the codec stays frozen. (b) scope them to the tab: address sections and assets by
ordinal under the reauthorized token, or reseal with any fresh layout. (b)
loses the fail-closed check on a content revision that changed while a tab
was open, which would then serve the new revision's section at the same
ordinal.

resolved when: the owner picks (a) and the hazard list says so, or (b) lands
and a tab opened before a republish either reloads or reads coherent content.
