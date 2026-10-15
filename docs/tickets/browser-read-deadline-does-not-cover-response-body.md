# browser reads lack a total deadline through response consumption

status: open (source-confirmed hazard; no live stall reproduction)
origin: 2026-10-14 lectern latency diagnosis, source `367da80e0`
area: web / read transport

`apps/web/src/lib/api/proxy.ts:74-82` starts a 30-second upstream timer, then
returns `upstream.body` at lines 113-116 and clears that timer in `finally`
at lines 125-127. browser `apiFetch` awaits `response.text()`
(`client.ts:201-206`) with no deadline of its own. `useResource.ts:143-191`
supplies lifecycle cancellation, not a time budget. body stalls therefore
have no application-owned total bound; proxy session resolution also happens
before its upstream timer. the server-side `callFastAPI` already keeps its
timer through body consumption and is a separate transport.

`retryPolicy.ts:8-10,54-83` permits three attempts, including upstream
timeouts. three header timeouts can spend roughly 91 seconds before section
failure. this calculation does not bound stalled bodies or prove that this
caused the reported production absence.

prerequisite: define a total ordinary-read budget and cancellation ownership.
own the deadline across browser acquisition, body consumption, retry and
backoff. keep lifecycle cancellation distinct from timeout; preserve genuine
stream/media transfer contracts and existing mutation reconciliation.

acceptance: delayed headers, a stalled body after headers, and retryable
failures all settle within the declared total read budget with truthful
feedback; cancellation releases owned transport work. no code changes here.
