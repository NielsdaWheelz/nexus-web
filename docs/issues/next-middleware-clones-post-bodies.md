# next's node middleware still clones server-action and auth post bodies

status: open
origin: 2026-10-18, the fix that took `/api/*` out of the middleware matcher
area: web / next middleware

next 15.5.22 clones the body of every non-GET/HEAD request a node middleware
matches (`next/dist/server/body-streams.js` `getCloneableBody`) and calls
`finalize()` without awaiting it (`next/dist/server/next-server.js:1257`;
15.5.28, the newest 15.x, the same at `:1259`).
`finalize()` rethrows a client abort (an unhandled rejection) and, once the body
ends, copies the clone's stream state onto the request while the handler may
still be reading it, which drops node's guard on the request's `error` event (an
uncaught exception on a later reset). `/api/*` no longer passes through it.
server actions (`app/(authenticated)/settings/{account,identities}/actions.ts`)
and the `/auth/*` post routes still do: middleware stamps their routing metadata
and auth-surface headers, and a matcher cannot select by method.

impact: web log noise; next logs and continues. afaict vercel runs middleware
outside next's own server, so production never takes this path; unverified.

evidence (`nexus-web-campaign-artifacts/2026-10-18/edge-fix/fix.md`): on `next
start`, a `POST /auth/password/sign-in` whose client resets mid-body logs
`⨯ unhandledRejection:  [Error: aborted] { code: 'ECONNRESET' }`, three of
three. a mechanism repro: an unawaited finalize plus an abort mid-body leaves an
unhandled rejection; a read racing the swap leaves an uncaught exception, even
with no client abort at all (an async-iterating reader's cleanup, `ABORT_ERR`);
an awaited finalize leaves neither. whether next's own action reader
(`app-render/action-handler.js:637`, `pipeline` + `for await`) races it is
unverified. next 16.4.2 awaits finalize (`next-server.js:1231`) and keeps the
swap.

resolved when: a next upgrade awaits finalize, and an auth or server-action
post aborted mid-body or mid-answer leaves the web server log without
`unhandledRejection` or `uncaughtException`.
