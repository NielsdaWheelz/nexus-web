status: open
origin: 2026-09-12 reader cutover verification, `eb1b742`
area: client defect telemetry / next request forwarding

the retained `f2f2c4d7c921aa05/web.log:5–16` records two failures in
`/api/telemetry/client-defects`: `TypeError: Cannot read private member #state
from an object whose class did not declare it`. the pane error report was not
delivered, hiding its original structural context.
`apps/web/src/app/api/telemetry/client-defects/route.ts:26` constructs a new
request from the framework request after decoding its body; the precise branding
failure requires confirmation at that request-forwarding boundary.

prerequisite: reproduce with the real next route and its actual request object.
repair request forwarding through the existing proxy owner while retaining
authentication, bounded structural fields and server-owned release identity.
do not swallow the exception or send source content in telemetry.

acceptance: a valid real-browser defect beacon reaches the backend once with its
structural context and release identity; malformed reports remain rejected and
the route emits no request-branding exception.
