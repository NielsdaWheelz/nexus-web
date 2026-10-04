# media file access success has no native output contract

status: open · origin: 2026-10-04 hosted reader original-proof review at
`e53d484ca68dc961ff884cf7afff32bd9782b2e7` · area: reader / typed wire

`api/routes/reader.py:159–170` returns `dict` for `GET /media/{media_id}/file`.
`services/media_file_access.py:86–107` constructs the two required strings
`url` and `expires_at`; generated `wire.gen.ts:16700–16721` exposes success as
an unknown-key object. web ownership is copied in
`ReaderDocumentSource.ts:54–65,108` and `resourceActionMenu.tsx:805–808`.
paths are under `python/nexus` or `apps/web/src` respectively. this is a
source-verified contract gap, not an observed download failure. the original
reader fixture correctly source-qualified this response rather than claiming
native dto validation.

prerequisite: admit the complete signed-access route and both web ingress
owners separately from reader composition; preserve read permission, missing
file and signing-error policy. no matching ticket was found; the public-pdf
stream-versus-signed-url decision concerns a different route.

fix: give the existing native output owner the required URL/expiry fields and
typed success envelope, then consume its generated type at both ingresses.
there is no structural reconstruction decoder to delete here. retain the real
expiry-to-milliseconds projection and its current nullable parse result.

acceptance: actual valid response URL/expiry spelling, envelope and bytes stay
unchanged; permission/missing/signing failures and signed-access renewal remain
owned as before. generated success is precise, both copied response shapes are
gone, and the sole static gate passes. no production storage or full download
journey is implied by the source finding.
