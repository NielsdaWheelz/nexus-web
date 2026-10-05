# Resource Sharing

Resource sharing gives another user, or any holder of an unlisted bearer link,
read access to one media or one of the owner's highlights. It never exposes the
owner's library, notes or other annotations, and it is separate from inbound
Android/web capture ([sharing.md](sharing.md)).

## Grants

`resource_grants` is the only access-grant table, owned by
`services/resource_grants.py`. A row gives its creator and exactly one audience
(a grantee user, or the holder of its raw `share_token`) read access to one
media or highlight. The database enforces the shape (0249): the subject scheme
is `media` or `highlight`, exactly one audience column is set, and a creator
holds one grant per subject and audience. A grant is also:

- an authorization path: `auth/permissions.py` reads the ORM and SQL
  predicates; a highlight grant opens that highlight and its media;
- a reference: while any grant names a document media or its highlights, the
  media is not torn down; revoking the last one claims the teardown.

Every grant mutation invalidates audience visibility for exactly the users it
affects, in the same transaction. Locks go media, then highlight, then grant,
the order media deletion uses. Revoke/decline runs READ COMMITTED and restarts
when a dedupe repoint moved the grant's subject while it waited.

`services/resource_sharing.py` serves the Share overlay: one ordered
availability check (mode, highlight present, not deleting, highlight owner,
media readable, highlight resolvable; then, for links, public readiness) whose
first failing reason wins. The create command re-runs it under the subject's row
locks, returns an existing grant for the same audience, and inserts under
SERIALIZABLE.
Library subjects carry `members` (can the viewer manage them) from
`library_governance.library_out`.

## Anonymous reader

A link is `{APP_PUBLIC_URL}/s#share=nxshr1_<43>`. The token lives in the URL
fragment and is stored raw; resolution is equality on that column and depends
on no key. `/s` sends it only in the `X-Nexus-Share-Token` header of
credential-free, uncached fetches to `/api/public/resource-share`, whose one
catch-all BFF route forwards four closed shapes (the share, `document`, `file`,
`assets/nxpa1_…`) and 404s anything else.

`services/public_resource_sharing.py` resolves the token, then gates the
subject. The gate is the same predicate link creation uses and may only
loosen, because tightening it breaks links already handed out: no teardown,
text-ready (else `ProjectionNotReady`), a succeeded source attempt, podcasts
fed by RSS, videos from YouTube with a disclosable URL, at least one
fragment/section, a PDF file, and a resolvable highlight. Every other outcome,
including bad handles and wrong-kind endpoints, is one masked
`404 E_NOT_FOUND "Share unavailable"`. Authorization precedes interpretation:
handles and Range are read only after the token passes; query strings are
ignored.

a read locks the media `FOR SHARE`, then reads its facts in a fresh statement.
article and transcript publication takes a conflicting parent `FOR NO KEY UPDATE`
or `FOR UPDATE` lock. an article or transcript highlight must resolve to a current same-media
fragment; a stale anchor fails upstream with the same masked 404. the share
is one response: title, bylines, disclosable source URL and the shared
highlight (quote, color, and a text anchor naming a fragment/segment ordinal or
a PDF page and quads). `document` is the reader document the signed-in reader
mounts (`GET /media/{id}/reader`, `services/reader_document.py`) projected
through the public allowlist: unit ids are ordinals, html passes `public_html`,
no embeds and no source issues; a PDF's file is `/api/public/resource-share/file`.
`/s` mounts it in the shared reader (`lib/documentReader`) read-only, opened at
the shared highlight. EPUB images are fetched by handles sealed to (grant,
media, content revision): HMAC under `STREAM_TOKEN_SIGNING_KEY`, byte-stable
across releases, so a content change fails old handles closed. PDF bytes stream through FastAPI with
the token reauthorized on every range request; there are no signed storage
URLs, and uvicorn aborts a body that disagrees with its Content-Length.

`public_html.py` is the closed HTML policy: tag and attribute allowlist,
script-like subtrees dropped, links forced external and referrer-free, every
image source removed and EPUB assets rewritten to handles (the reader fetches
them with the token as units near the viewport).
`public_source_urls.py` decides the disclosable URL: a generic web URL (ingest
already validated and normalized it) minus params, query and fragment; X,
YouTube and arXiv only when every identity of the attempt agrees; nothing else.

Every public API response, errors included, carries `Cache-Control: private,
no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`,
`nosniff`, `Cross-Origin-Resource-Policy: same-origin`, a `default-src 'none'`
CSP and no `Set-Cookie`, stamped by `app.py`'s middleware, the BFF and
`web/middleware.ts`. The WAF rate-limits `^/api/public/resource-share(?:/.*)?$`.

## Web

`lib/sharing/controller.tsx` owns the one Share overlay
(`components/sharing/ShareOverlay.tsx`): Nexus link copy/share, people search,
person grants, received access with decline, the public link (copy, native
share and X behind bearer warnings, turn off), and library People. Route
targets copy the pane's address without a request. The wire types of every
route here come from `lib/api/wire.gen.ts`.

`app/s/PublicShareReader.tsx` renders the document in the shared reader
(`lib/documentReader`'s `DocumentReaderView`) over `publicSource.ts`
(`document`, token-authorised epub images as units near the viewport, the pdf
file with the token header), read-only: no progress, no selection, the shared
highlight as its one mark (global `hl-*` colors) and its entry target.
