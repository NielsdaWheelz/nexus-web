# a read storm can fail the authored store

status: open; source review and adjacent timing, not a reproduced terminal failure.

`apps/web/src/lib/authored/client.ts:call` abandons a call after 30s; two timeouts
without an intervening answer fail the port with `the local notes store isn’t
responding`. the worker can still execute abandoned reads in order.

original evidence: 280 mounted rows took 28.4s to settle in firefox. total settle
time is not a call's queue latency, so proximity to the deadline is an inference.
contained-reading excerpt queries can page intervals and quote windows per row.

connections-scroll removes placed rows' own reads, gates child proof work until
rest, and limits mounts. clipped-quote fill and non-held rows still use the existing
queue. this removes the observed trigger without establishing a queue bound.

impact: read backlog can disable local writing for the page. fix cancellation or
read admission at the worker/client owner, preserving serialized writes.

resolved when abandoned reads do not execute, or measured normal list use proves
queued calls cannot reach the timeout, including contained readings.
