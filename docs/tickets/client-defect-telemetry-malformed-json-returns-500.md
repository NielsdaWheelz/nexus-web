# client defect telemetry returns 500 for malformed json

status: open · origin: 2026-09-17 telemetry cleanup · area: client defect telemetry

on merged main `4d0b986f2`, a real chrome `sendBeacon` with an authenticated
session and an `application/json` body containing only `{` returned 500. the
local upstream received zero requests. `apps/web/src/app/api/telemetry/client-defects/route.ts`
calls `request.json()` before proxy authentication or backend validation, and
does not classify its `SyntaxError`.

this makes a malformed optional telemetry report look like a server defect.
decide the bff's syntax-error response contract, then catch only malformed json
at this route; do not duplicate the backend's structural schema.

acceptance: a real-browser malformed beacon receives the chosen structured 4xx
with zero upstream requests; authenticated valid reports still reach the
backend once, and anonymous reports still return 401.
