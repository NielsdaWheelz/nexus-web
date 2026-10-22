# the web server logs an uncaught `aborted` exception under cold page loads

status: open
origin: 2026-10-21, pane chrome harness (`nexus-web-campaign-artifacts/2026-10-21/chrome/harness`, D9)
area: web / next server

the standalone next server logs `⨯ uncaughtException:  [Error: aborted] {
code: 'ECONNRESET' }`, intermittently, on main and on the pane chrome branch.
on main: once in seven full harness runs at 631dba5dc
(`runs/dev/r2-baseline-1.txt.web.log`) and once on a freshly started server at
c69ba7cba, right after "Ready", before any journey ran
(`runs/dev/base-reslice.txt.web.log`). on the branch: twice in five full runs
and once in ten isolated repeats, each inside `H.every-route-form-deep-links`
(31 consecutive cold page loads, each unloading the last under its requests;
no server action or auth post runs in it), and early in a server's life.

the aborted request is unidentified. 248 instrumented cold loads of the same 31
forms on a warm server, recording every failed request, did not reproduce it,
and `--trace-uncaught` printed no stack (next's own `uncaughtException` handler
catches it). candidates, both unproven: the request-body swap described in
[next-middleware-clones-post-bodies](next-middleware-clones-post-bodies.md)
reached by another path, or next's first, lazy load of a route under an abort.

impact: log noise so far: no journey failed with it, and the page and the
workspace were unaffected. an uncaught exception in a long-lived server is a
crash risk wherever the process does not survive it.

resolved when: the aborted request and its owner are identified and repaired,
and full harness cycles on a fresh server log no `uncaughtException`.
