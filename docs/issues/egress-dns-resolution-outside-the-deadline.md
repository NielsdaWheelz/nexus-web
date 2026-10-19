# egress dns resolution runs outside the fetch deadline

status: open, source-qualified; no runtime probe.
origin: 2026-10-10 url acquisition reauthor (branch cleanup/url-acquisition-reauthor, base d287e91f7).
area: ingest / egress.

`net/safe_fetch._vetted_target` (`python/nexus/services/net/safe_fetch.py:195`)
calls `socket.getaddrinfo` once per hop with no timeout. the call's
`timeout_s` bounds connect, reads and every body read, but not resolution: a
slow or unresponsive resolver holds the fetch for the resolver's own limits
(glibc: `timeout`×`attempts` per nameserver, 5 s×2 by default) on every hop,
up to six hops for an article.

fix: resolve on a bounded path (a resolver with a per-query timeout taken from
the remaining deadline, e.g. a worker thread joined with the remainder) and map
expiry to `Timeout`.

acceptance: with a resolver that never answers, `safe_get(url, timeout_s=5)`
fails as `E_INGEST_TIMEOUT` within ~5 s.
