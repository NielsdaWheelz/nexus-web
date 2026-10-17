# an aborted request body leaves an unhandled rejection in the web server

status: open
origin: 2026-10-14 cleanup stack replay onto main 367da80e0 (edge harness E26); cause in
main #607 (`middleware.ts` `runtime: "nodejs"`)
area: web / bff, next middleware

the node-runtime middleware matches every path except static output, `/api/*` included.
next 15.5.22 clones a matched request's body for middleware
(`next/dist/server/body-streams.js` `getCloneableBody`) and, after the middleware,
calls `requestData.body.finalize()` in a `finally` without awaiting it
(`next/dist/server/next-server.js:1257`). `finalize()` rethrows the stream's error, so a
client that aborts while its body is still arriving produces, besides the bff's handled
read failure, an unhandled rejection:

```
[Error: aborted] { code: 'ECONNRESET' }
 ⨯ unhandledRejection:  [Error: aborted] { code: 'ECONNRESET' }
bff_upstream_failed [Error: aborted] { code: 'ECONNRESET' }
```

evidence: edge harness run `2026-10-14/replay2/runs/tip1-edge.txt`, E26 (two such lines in
the web server log); the edge-runtime middleware before #607 never cloned bodies and E26
passed on the previous replay (absorb tip2-edge.txt). `g3-tip2-edge.txt` (stack 11) logged
three: two `unhandledRejection` and one `⨯ uncaughtException:  [Error: aborted] { code:
'ECONNRESET' }`, the same abort surfacing as an unhandled stream error.

what to do: keep the middleware off paths whose handlers own their bodies (`/api/*`; the
middleware already passes them through), or await-and-catch upstream once next fixes it.

acceptance: edge E26 passes with clients aborting mid-body; no `unhandledRejection` or
`uncaughtException` in the web server log.

2026-10-16 mobile palette qualification reproduced the same abort rejection
in the isolated next 15.5.22 production server during deliberate transport-abort
journeys. those palette journeys passed; this server-level defect remains open.
see [the qualification record](../mobile-command-palette-verification.md).
