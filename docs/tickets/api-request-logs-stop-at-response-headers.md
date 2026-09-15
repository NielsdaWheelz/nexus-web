# api access logs cannot identify requests killed before headers

status: open · origin: 2026-09-15 reader oom diagnosis · area: api observability · oi-132

`python/nexus/middleware/request_id.py:133–157` emits
`http.request.completed` after `call_next` returns response headers, before
response-body transfer finishes. it emits no request-start event. the695 api
kills at22:24:54,22:26:03,22:29:01 and22:31:46 utc therefore leave neither an
identity for requests killed before headers nor proof that logged200 bodies
finished. this limits diagnosis; it is not established as the crash cause.

use the existing request-id/path/method logging owner to record request entry
and name response-header observations accurately. do not log bodies, bearer
credentials, query strings or local variables. if transfer completion is
required, observe the actual asgi body boundary rather than rename headers as
completion. acceptance: an interrupted request remains identifiable and a
logged header status cannot be mistaken for completed delivery.
