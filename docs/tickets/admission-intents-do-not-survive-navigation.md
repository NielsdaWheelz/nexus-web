# uncertain admission intents do not survive navigation

status: open
origin: 2026-10-14 x title implementation review
area: browser / mutation replay

metadata and source-refresh intents live in module maps (`unconfirmed` in
`apps/web/src/lib/media/mediaMetadataOperations.ts`, `unconfirmedRefreshes` in
`apps/web/src/lib/imports/api.ts`; until the actions reauthor, provider-owned maps
in the deleted `resourceActionRuntime.tsx`). a full reload or login navigation
discards the original request identity. the unauthenticated handler
at `apps/web/src/lib/auth/UnauthenticatedApiBoundary.tsx:17` uses
`window.location.assign`. retaining an intent on 401 therefore preserves it
only until navigation; 403/404 retention works until the page unloads.

if a request succeeded but its response was lost, and its job finishes before
the user returns, a fresh action can create another job instead of confirming
the original receipt. source-qualified; the callback proof does not exercise
login navigation. this is the existing in-memory metadata mechanism's scope,
also reused for source refresh.

prerequisite: choose whether replay continuity must survive browser sessions.
if required, retain the exact unresolved request per user until its receipt or
definitive owner refusal; keep logout/account changes explicit.

acceptance: lose an accepted response, complete its job, navigate through login,
then confirm the original request bytes and receive its original job id without
another admission.
