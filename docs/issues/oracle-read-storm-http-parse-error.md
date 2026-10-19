# a read storm against the api once got a response that is not http

status: open · origin: 2026-10-05 combined oracle landing review (cleanup/oracle-reauthor, harness runs r10, r12) · area: api / http transport

the isolated harness's `J3.read-during-publish` (two detail loops and one
first-frame sse loop on one keep-alive pool, node 26 fetch, against uvicorn) failed
twice, once per full journey run on a loaded host: r10 `TypeError: fetch failed`
after 7.5 s with no status; r12 the same, with its cause printed: `Response does not
match the HTTP/1.1 protocol (Expected HTTP/, RTSP/ or ICE/)`, 28 s in. llhttp saw
bytes that do not start a response on a socket the client had sent a request on: a
pooled socket carrying bytes outside the previous response (an abandoned sse stream's
frames, or a response overrunning its length). which side wrote or reused them is
unknown. a quiet-stack probe of the same shapes (r13: shared pool, detail only, sse on
its own socket; 37,317 operations, 20 s each) never failed.

proposed: rerun J3 on a loaded stack with undici's diagnostics channels logging each
request's socket (local port) and the api's access log, to tell a client reusing an
aborted sse socket (a harness artifact: give sse its own dispatcher) from the api
writing past a response (a product defect at the response layer).

acceptance: the cause is named with that evidence and fixed where it lives, or shown
to be the harness client and this ticket deleted.
