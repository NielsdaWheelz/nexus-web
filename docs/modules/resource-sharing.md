# Resource Sharing

Resource sharing grants another user or an anonymous bearer access to one media
or owned-highlight subject. It does not expose the owner's library, notes, or
other annotations; it does not turn `resource_edges` into ACLs; and it is
separate from inbound Android/web capture, which remains owned by
[sharing.md](sharing.md).

## Grants and authority

`resource_grants` is the sole persisted access-grant table. A row grants one
canonical `ResourceRef` to either one sealed user identity or one random link
bearer. `services/resource_grants.py` owns creation, resolution, listing,
revocation/decline, token hashing, lock order, and subject cleanup.
`services/resource_sharing.py` owns the authenticated snapshot, availability,
and create projection. Permissions consume the grants; search, readers, and
highlight access do not reimplement them.

The capability registry closes the product surface:

- media: `ResourceGrants`;
- owned highlight: `HighlightGrants` (the parent media plus that highlight,
  never the author's other annotations or notes);
- library: membership-only route sharing, never a link grant;
- podcast: copy plus library filing;
- unsupported resources: no Share action.

Authenticated APIs use canonical `ResourceRef` subjects and sealed
`nrg1.*`/`nus1.*` handles. Handles identify records but do not authorize.
`POST /resource-items/{ref}/shares` rechecks the selected audience; DELETE
removes only the named path. A recipient can reshare media through an independent
grant. Revoking an upstream grant therefore does not recursively revoke a
downstream grant.

## Anonymous projection

The public href is `/s#share=nxshr1_…`. The fragment keeps the bearer out of the
HTTP request target. Browser code sends it only in `X-Nexus-Share-Token` to the
exact `/api/public/resource-share` tree; the BFF strips cookies, authorization,
and caller-supplied internal trust before forwarding. FastAPI exempts only that
closed read-only tree after internal trust validation.

`services/public_resource_sharing.py` is an allowlist projection, not an
unauthenticated form of the normal media API. It emits strict V1 DTOs for article
fragments, EPUB navigation/sections/assets, PDF bytes/ranges, and video/podcast
transcript segments. It never emits raw storage paths/URLs, database IDs,
library/user identity, notes, annotation collections, or mutation affordances.
Every subresource reauthorizes the header token. Invalid, revoked, deleted,
tearing-down, stale-handle, unsupported, and malformed-subresource cases share
one `404 E_NOT_FOUND / Share unavailable` envelope.

Public resolution holds `Media FOR SHARE`. Source publishers hold
`Media FOR UPDATE` across current web/EPUB/PDF/transcript row publication, so a
bootstrap/body/handle revision cannot mix generations. PDF delivery HEAD-checks
the private object against persisted content type and size before returning
200/206. EPUB handles and cursors bind the grant, media, kind, ordinal, and
complete source revision; refresh makes old handles fail closed.

Only provenance-owned source URLs are eligible for explicit “View original”
egress. Generic public HTTP URLs lose query, params, and fragments and reject
credentials/IP/private-style hosts. X, YouTube, and arXiv URLs must resolve from
agreeing typed source identities. Captured/uploaded/email source URLs are absent.
The reader sanitizes public HTML, loads EPUB image bytes through token-authorized
opaque asset handles, sets no-store/no-referrer/noindex/nosniff headers, and
loads no third party until a user explicitly opens the disclosed source link.

## Product surface

The universal `ShareControllerProvider` owns one responsive modal. Pane chrome,
resource menus, media/podcast/highlight actions, and selection-create-then-share
flows call its central target/options builders; they do not grow bespoke copy or
membership dialogs. Copying an authenticated URL never changes access.
