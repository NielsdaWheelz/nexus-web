# the context-refs POST loses its only browser producer

status: open · origin: 2026-09-17 slop sweep (claude session) · area:
conversation context refs · oi-158

`addContextRef` (`apps/web/src/lib/resourceGraph/contextRefs.ts:102-114`) has
one repo-wide occurrence — its own definition — and the web-lib-data slice PR
deletes it as unreferenced; its siblings `listContextRefs` and `removeContextRef`
stay live. with it gone, `POST /conversations/{id}/context-refs` has no producer
at all. context refs reach the client only through the SSE `context_ref_added`
event, so the write chain is orphaned rather than merely quiet.

fix: once the web-lib-data PR lands, delete the chain — the POST handler in
`apps/web/src/app/api/conversations/[id]/context-refs/route.ts`,
`add_context_ref` in `python/nexus/api/routes/conversation_context.py:72`, its
service function, and `ContextRefCreate` in
`python/nexus/schemas/resource_graph.py:38`.

prerequisite: the web-lib-data slice PR has landed, and the android and
extension clients are confirmed not to call the endpoint (both are documented as
making no product API calls; verify before deleting).

acceptance: no route in the repo accepts a context-ref creation that nothing can
send, and attaching context to a conversation still works through the paths that
remain.
