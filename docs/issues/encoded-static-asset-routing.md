# missing or encoded static assets reach protected routing

status: open; missing-asset routing defect confirmed
origin: 2026-10-16 pr #655 inspection, source `41221d947`; production recurrence on `01c35faa931af236ce625cec14b44488e777bace`
area: web / static routing

on the next 15.5.22 standalone build, requesting
`/_next/static/chunks/app/%28authenticated%29/%5B%5B...path%5D%5D/page-e35075ea737d4d6c.js`
returns 500 and logs `Protected request routing metadata missing or invalid`.
the throw is `apps/web/src/lib/auth/session.ts:161`.
the same path with literal parentheses/brackets returns 200 javascript. this
was an over-encoded inspection request; tested browser asset requests work.

on 2026-10-17 at 06:28z, an ordinary browser visiting `/version` requested
`/favicon.ico` and received 500. public read-only requests also proved an absent
`.svg` receives 500, while `/icon.svg` returns 200. the exact-source isolated
build reproduces both failures and logs the same routing-metadata error.
an anonymous extensionless unknown route instead receives the expected 303
login response; this does not establish a general not-found failure.

cause: `apps/web/src/middleware.ts:172` excludes these asset paths, but absent
assets fall through to `apps/web/src/app/(authenticated)/[[...path]]/page.tsx`.
its layout calls `verifySession()` without middleware's routing metadata and
throws before checking a session. the older
[final-firefox-favicon-request-failed](final-firefox-favicon-request-failed.md) records the same favicon
500 during the prior session-entry qualification; it was not introduced by this
release.

evidence: private release packet `proof/production-favicon-read.json`,
`proof/production-missing-route-diagnosis.json`,
`proof/local-missing-route-diagnosis.json`, and
`clients/stack/web-historical-production.log` at source `01c35faa931`.

impact: browser fallback icons and missing or unsupported static paths produce
server errors. the application's declared icon and observed normal assets load.
repair ownership of static misses before they enter protected rendering; do not
weaken session metadata checks or add a favicon shim to conceal the route defect.

done: supported asset encodings return identical bytes; absent or unsupported
static paths, including `/favicon.ico`, receive a deliberate not-found response
without rendering a protected page or raising an uncaught routing defect.
the declared `/icon.svg` and ordinary authenticated navigation still work.
