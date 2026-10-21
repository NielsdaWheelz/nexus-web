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

- an authorization path: `auth/permissions.py` reads its SQL predicates; a
  highlight grant opens that highlight and its media;
- a reference: while any grant names a document media or its highlights, the
  media is not torn down; revoking the last one claims the teardown.

Every grant mutation invalidates audience visibility for exactly the users it
affects, in the same transaction. Locks go media, then highlight, then grant,
the order media deletion uses. Grants and users are addressed by plain uuids.
`DELETE /resource-shares/{grant_id}` revokes (creator) or declines (grantee);
an absent grant, or one that is not the viewer's, answers 204 too. It runs READ
COMMITTED and restarts when a dedupe repoint moved the grant's subject while it
waited.

`services/resource_sharing.py` serves the Share overlay: one ordered
availability check (mode; a subject the viewer cannot read is 404, as its
snapshot is; not deleting, highlight owner, highlight resolvable; then, for
links, public readiness) whose first failing reason wins. `POST
/resource-items/{ref}/shares {id, audience: {kind: "User", user_id, email|null} |
{kind: "Link"}}` re-runs it under the subject's row locks and inserts under
SERIALIZABLE with the client's id. Retry: the same id answers that grant (409
`E_RESOURCE_CONFLICT` when it names another), and the creator's existing grant
for the same audience answers as it is (`created: false`). `email` is the email
the sharer typed (400 when it is not the user's, ignoring case); the grant stores
it, and the sharer's rows show the grantee's email only as typed, otherwise
null (the web shows the display name, else "Unknown person"). A received share
names its sharer, email included.
Library subjects carry `members` (can the viewer manage them) from
`libraries.access(…).out(…).can_manage`.

## Anonymous reader

A link is `{APP_PUBLIC_URL}/s#share=nxshr1_<43>`. The token lives in the URL
fragment and is stored raw; resolution is equality on that column and depends
on no key. `/s` sends it only in the `X-Nexus-Share-Token` header of
credential-free, uncached, no-redirect fetches to `/api/public/resource-share`,
whose one catch-all BFF route forwards four closed shapes (the share,
`document`, `file`, `assets/[0-9]{1,9}`) and 404s anything else. The PDF's
bytes ride the same fetch, not pdf.js's own, which would send the viewer's
cookies: one `bytes=0-` read streams the whole file, and a chunk pdf.js needs
before the stream reaches it is read by range.

`services/public_resource_sharing.py` resolves the token, then gates the
subject. The gate is the same predicate link creation uses (`link_readiness`)
and may only loosen, because tightening it breaks links already handed out: no
teardown; text-ready (else `ProjectionNotReady`); a succeeded source attempt;
a podcast episode only with a publisher transcript
(`transcript_origin = 'Publisher'`); a video only from `youtube_video` with a
disclosable URL; an EPUB with a succeeded EPUB attempt; a PDF with an
`application/pdf` file of at least one byte; any other kind with a fragment;
and a resolvable highlight. Its facts are one statement after the lock: no
section or asset read. Every other outcome, including wrong-kind endpoints and
unknown ordinals, is one masked `404 E_NOT_FOUND "Share unavailable"`.
Authorization precedes interpretation: path segments and Range are read only
after the token passes; query strings are ignored.

A read locks the media `FOR SHARE`, then reads its facts in a fresh statement.
Article and transcript publication takes a conflicting parent
`FOR NO KEY UPDATE` or `FOR UPDATE` lock. An article or transcript highlight
must resolve to a current same-media fragment; a stale anchor fails with the
same masked 404. The share is one response: title, bylines, disclosable source
URL and the shared highlight (quote, color, and a text anchor naming a
fragment/segment ordinal or a PDF page and quads). `document` is the reader
document the signed-in reader mounts (`services/reader_document.py`, built with
no viewer, so no embeds) rebuilt field by field through the public allowlist: a
field the private document gains never crosses unseen. Unit ids are ordinals,
html passes `public_html`, source issues are empty; a PDF's file is
`/api/public/resource-share/file`. `/s` mounts it in the shared reader
(`lib/documentReader`) read-only, opened at the shared highlight.

EPUB images are `assets/{n}`: `n` indexes the media's public image list
(`epub_assets.list_public_epub_asset_sources`: every stored image type but SVG,
in package order); `n >= len` is the masked 404. Published EPUB content is
immutable (`reader_publication` refuses replacing it), so an ordinal in an open
tab names the same image for as long as the link lives; if republication is
ever allowed, the asset path must carry the publication generation. PDF bytes
stream through FastAPI with the token reauthorized on every request; there are
no signed storage URLs. The first storage chunk is read before the answer
starts, so a missing or failing object is the masked 404, not a truncated body.
A single `bytes=a-b` or `bytes=a-` range answers 206 with `Content-Range`; a
range in another unit or several ranges get the whole file (200); an
unsatisfiable range is 416 `E_INVALID_REQUEST` with `Content-Range: bytes */size`.

`public_html.py` is the closed output policy, separate from (and stricter than)
ingest sanitizing: tag and attribute allowlist (the structural containers ingest
keeps stay, so an in-document link's target id survives), script-like subtrees
dropped, `on*` stripped; absolute http(s) links without credentials open `_blank` with
`noopener noreferrer` and `referrerpolicy=no-referrer`; a same-document `#id`
link stays; an EPUB link to another unit names it by ordinal
(`data-nexus-fragment-id`, plus `data-nexus-anchor-id`, `href="#"`); every other
href is removed; every image loses its source, and an EPUB image whose source
is its private asset path carries its ordinal as `data-nexus-public-asset`.
`public_source_urls.py` decides the disclosable URL: a generic web URL (ingest
already validated and normalized it) minus params, query and fragment; an X
post or YouTube video only when its ref and every URL of the attempt agree; a
`remote_pdf_url` only when every URL names the same arXiv paper
(`https://arxiv.org/abs/<id>`); nothing else.

Every public API answer, errors included, carries `Cache-Control: private,
no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`,
`nosniff`, `Cross-Origin-Resource-Policy: same-origin`, a `default-src 'none'`
CSP and no `Set-Cookie`, stamped by one `next.config.ts` header rule over the
path (`lib/security/headers.ts` `SHARE_SECURITY_HEADERS` after the static suite);
`/s` itself is noindex, no-referrer and no-store under `publicReaderCsp`.

The Vercel WAF rate-limits the share path per ip, fixed 60 s windows, denying
(403) past the limit, with two disjoint rules in `deploy/vercel/firewall/`.
Byte reads, `^/api/public/resource-share/(?:file|assets/[0-9]{1,9})$`, get 600
(`resource-sharing-bytes.json`); every other path under
`^/api/public/resource-share(?:/.*)?$` gets 120 (`resource-sharing.json`, whose
negated second condition excludes the byte paths, so no request counts against
both and rule order does not matter). Byte reads come in bursts: a pdf opens
with one `bytes=0-` stream plus a range read for each top-level page-tree kid
the stream has not yet reached (pdf.js prefetches every kid of the root
`/Pages`, so a flat-tree 200-page scan costs ~200), and an epub unit fetches
every image at once. 600 holds a 200-read open plus a 150-image chapter
(350) with 250 to spare. Summary and document are two requests an open, so 120
leaves them ample. A flat-tree scan past ~600 pages still exceeds its limit
(issue `public-share-pdf-open-burst-exceeds-waf-limit`).

## Web

`lib/sharing/controller.tsx` owns the one Share overlay
(`components/sharing/ShareOverlay.tsx`): Nexus link copy/share, people search,
person grants, received access with decline, the public link (copy, native
share and X behind bearer warnings, turn off), and library People. One change
runs at a time; every other control waits for it.

People search (`GET /users/search?q&limit≤20`, `components/users/PeopleSearch`,
shared with the library Members tab) finds users whose display name contains
`q` (at least 3 characters) or whose email is exactly `q`, never the viewer. It
returns an email only on that exact match, so no search lists addresses. Route
targets copy the pane's address without a request. The wire types of every
route here come from `lib/api/wire.gen.ts`.

`app/s/PublicShareReader.tsx` renders the document in the shared reader
(`lib/documentReader`'s `DocumentReaderView`) over `publicSource.ts`
(`document`, token-authorised epub images by ordinal as blob urls revoked with
their unit, the pdf's byte ranges), read-only: no progress, no selection, the
shared highlight as its one mark (global `hl-*` colors) and its entry target.
Only the server's masked 404 reads as a dead link ("Share unavailable"); a
transport failure shows its copy with Retry (focus waits on the page's status
region while it retries). Only a `#share=` hash change
re-resolves; an in-document link never leaves the reading.
