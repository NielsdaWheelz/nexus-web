# percent-encoded app asset path reaches protected routing

status: open; outside palette behavior
origin: 2026-10-16 pr #655 served-artifact inspection, source `41221d947`
area: web / static routing

on the next 15.5.22 standalone build, requesting
`/_next/static/chunks/app/%28authenticated%29/%5B%5B...path%5D%5D/page-e35075ea737d4d6c.js`
returns 500 and logs `Protected request routing metadata missing or invalid`.
the throw is `apps/web/src/lib/auth/session.ts:182`.
the same path with literal parentheses/brackets returns 200 javascript. this
was an over-encoded inspection request; tested browser asset requests work.

impact: an alternate encoded asset request falls into a protected rendering
failure. determine the static-route/middleware classification before changing
the authenticated routing contract; never weaken its metadata check.

done: supported asset encodings return identical javascript, and unsupported
encodings receive a deliberate client/not-found response without rendering a
protected page or raising an uncaught routing defect.
