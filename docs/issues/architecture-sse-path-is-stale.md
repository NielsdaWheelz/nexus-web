# architecture describes a stale browser stream path

problem: the runtime topology bullet at `docs/architecture.md:154-155` calls sse
the documented exception to the bff path (**browser → fastapi `/stream/*`**).
the same document's diagram (`:75`) and its live-streams section (`:319-335`)
say a stream is an ordinary session request through the bff, which is what the
code does. reasoning about stream auth, latency or the 280 s cut from the
topology bullet starts from the wrong path.

evidence (source at `2e154f053`): `apps/web/src/lib/api/stream.ts:1-3,20,83`
opens a same-origin `/api/stream/…` request;
`apps/web/src/app/api/stream/[...path]/route.ts:14-15` forwards it through
`proxySession(request, target, "Stream")`. `docs/modules/api-edge.md:58,77-78,92`
describes the `Stream` lane, its clean 280 s end and `maxDuration = 300`.
doc-only; no runtime defect.

fix: replace the exception with the bff stream path and point at §5.3 and the
api-edge module. do not introduce a second transport contract.

resolved when no part of `docs/architecture.md` describes a direct
browser-to-fastapi stream.
