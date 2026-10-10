# auth documents lose Vary: Cookie

status: open · origin: 2026-10-10 auth harness (D11, coordinator review R4) ·
area: web auth / headers.

`apps/web/src/middleware.ts` sets `Vary: Cookie` (with `Cache-Control: private,
no-store`) on `/login`, `/forgot-password`, `/account/password`, `/auth/*` and
protected pages, but next's app renderer replaces `Vary` on documents with its
own (`rsc, next-router-state-tree, next-router-prefetch,
next-router-segment-prefetch, Accept-Encoding`). route handlers keep it
(`lib/auth/session.ts` `finish`). evidence: the auth harness journey
J13.auth-vary (XFAIL on the rebase baseline at 0f664f1e8 and on the reauthor).
harmless while the documents are `private, no-store`: no shared cache stores
them.

fix: make next keep the middleware's `Vary` (or add `Cookie` to the renderer's
own), or drop the claim from spec I3 for documents.

acceptance: J13.auth-vary passes, or the invariant is restated for route
handlers only.
