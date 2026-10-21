# a key-set outage queues requests behind failed fetches

status: open · origin: 2026-10-20 python auth re-slice (`cleanup/python-auth-reslice`) · area: api auth

`TokenVerifier._key` (`python/nexus/auth/verifier.py:59-77`) lets one request
fetch the key set while the others wait on `self._fetching`; a waiter skips its
own fetch only when one *landed* while it waited (`_fetched_at` moved). when the
fetch fails (the provider's jwks unreachable, 5 s timeout), nothing moves, so
each waiter fetches in turn: the n-th request waiting on an expired cache (or
an unknown kid past the cooldown) answers its 503 `E_AUTH_UNAVAILABLE` after
about n × 5 s instead of 5 s. cached keys stop serving once their hour is up
(no stale-while-revalidate, design trade-off 10).

impact: during a supabase jwks outage longer than the key set's hour, api
latency grows with concurrency until callers time out; the outcome (503,
credentials kept) is unchanged, and the event loop and the requests with fresh
keys are unaffected. main before the slice did worse: each fetch blocked the
event loop.

evidence: code reading; journey A-PY.jwks-unreachable (one request) and
A-V2.cached-key-never-waits (a slow fetch that succeeds) do not cover it.

fix: let waiters share a failed attempt (an attempt counter and its outcome
beside `_fetched_at`), or serve stale keys while a refetch fails.

resolved when n concurrent requests against an unreachable key set with an
expired cache all answer 503 within one fetch timeout (a boot api journey with
`jwks` unreachable after a warm fetch and the ttl shortened).
