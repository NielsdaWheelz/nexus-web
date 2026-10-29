# async connection cancellation leaves startup socket open

status: open; engine-owner source fix implemented; native retirement proof pending.

worker image `1ed36c…`, source `ea918ffe151957fd9f48d14d82f82be2fa3841eb`,
schema identity 0329: a stalled-connect case with native `connect_timeout=2`
and a shorter 0.5-second async outer deadline returned after 0.501 seconds.
the peer received 206 startup bytes but saw neither eof nor reset within three
seconds; its observer remained alive after the database scope exited. the async
case failed the helper's line 175 socket-retirement assertion and remains FAILED.
no real database or job claim participated.

impact: timely cancellation of the awaiting operation does not prove retirement
of its in-progress connection. scope exit/capacity reuse may leave an unowned
startup socket; this does not establish an orphaned postgres backend or its cause.
the separate sync case passed at 2.106 seconds; actual heartbeat join passed at
2.111 seconds, 7.465 seconds total. neither pass closes the async failure.

reproduce with the retained `.nexus-local/pr866-connection-policy.private.py`,
sha256 `cbc7f0a8e35ecee2e417eed8b6d48819a47c8f7607336f9ba8fb8e2bdc2df5cf`,
against an isolated peer that accepts startup bytes and stalls. private native
evidence is on dev-server under
`/tmp/nexus-search-native-20261026/connection-policy-ea918-retained/results/async.result.private.json`
and `async.stderr.private`. preserve the failed receipt and frozen source.

a follow-up with garbage collection disabled retained the original canonical
pool shape (size 1, checked out 0) while the startup fd remained open for three
seconds. manual collection of 458 objects closed it; pending `_connect_gen` and
compiled-generator state was observed. direct-driver startup retired naturally.
a separate-task case passed; it does not erase the original canonical-shape
failure or prove this source fix. these controls narrow ownership without
claiming a complete upstream cause.

the source fix uses sqlalchemy's public `async_creator` at the existing engine
owner. native URL arguments retain dialect conversion and current override
precedence. one owned task shields psycopg startup; cancellation joins it and
closes any returned connection before the creator releases its pool capacity.
cleanup is shielded from repeated caller cancellation and preserves the original
cancellation even if native startup/close fails. no garbage collection, private
driver hook, registry, quota increase or deadline change is introduced.

the 0.5-second reproduction and readiness's 1.9-second work deadline are logical
cancellation deadlines, not cleanup/response bounds. native `connect_timeout=2`
applies per resolved address after DNS; it is not a total setup/checkout bound.
the source fix is not yet native-qualified. preserve the failed ea918 receipt;
engine disposal, an outer timeout or a close attempt alone is not positive
physical-retirement evidence.

resolved when the targeted shorter-deadline case confirms peer closure and joins
its observer before claiming retirement/capacity reuse, with no leftover startup
connection, followed by useful connection recovery. preserve sync/heartbeat
bounds and existing deadline/failure meanings; qualify through isolated owners,
not production. also require repeated cancellation and a connection returned
at cancellation to finish explicit close, without relying on garbage collection.
this finding remains a release-proof limit until those observations pass.
