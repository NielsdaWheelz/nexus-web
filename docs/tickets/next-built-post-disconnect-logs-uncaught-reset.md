# built post disconnect logs an uncaught reset

status: open
origin: 2026-10-15 suggestions publication live qualification, `fde33a16367b4d04bb4fcf92d7dc47962897675d`
area: web / next production transport

on next `15.5.22`, aborting an authenticated post after response headers and one
body byte logs `uncaughtException: [Error: aborted] { code: 'ECONNRESET' }`.
`POST /api/stream-token`, whose native-body proxy path is unchanged, and
`POST /api/lectern/suggestions/view` reproduce the same error. equivalent gets
are clean. the process remains healthy and subsequent `/api/me` returns 200.

an isolated second standalone server and relay held actual api responses for
20 seconds; the client aborted after 300 milliseconds. a passive
`uncaughtExceptionMonitor` recorded `node:_http_server:942 abortIncoming` →
`socketOnClose` → `Socket.emit`. it did not intercept or suppress the error.
proof: [sanitized transport receipt](../verification/suggestions/transport-isolation.json).
`apps/web/src/app/api/stream-token/route.ts:19` selects the
unchanged proxy control; `apps/web/src/lib/api/proxy.ts:156` owns its native
response body. this is inherited post-disconnect behavior, not evidence that
the suggestions response wrapper caused the exception.

first locate the exact next request-body propagation owner; the stack alone
does not identify that internal path. repair or upgrade that owner. do not mask
all uncaught exceptions or change streaming/media deadlines as a workaround.

acceptance: authenticated native and selected post disconnects settle without
an uncaught reset; gets, body deadlines, subsequent requests and ordinary
streaming retain their behavior in the built standalone server.
