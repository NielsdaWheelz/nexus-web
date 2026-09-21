# unauthenticated api redirect has two owners

status: open · origin: 2026-09-21 auth audit · area: browser session recovery

`apps/web/src/lib/auth/UnauthenticatedApiBoundary.tsx:18-57` exposes a direct
handler and a context handler with separate redirect-once flags. after a
redirect starts, the direct handler returns true, while the context handler
returns false. its unhandled-rejection listener therefore stops consuming
subsequent auth rejections despite the shared handler recognizing them.

fix: retain one handler/redirect state and a thin event-listener boundary.
cut callers to that contract without a compatibility api.

acceptance: concurrent 401/E_UNAUTHENTICATED failures start one navigation and
receive consistent handled results; unrelated failures still reach their
normal boundary. pass `./scripts/test`.
