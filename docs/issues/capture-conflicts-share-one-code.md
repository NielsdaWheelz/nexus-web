# capture conflict causes share one code

`E_RESOURCE_CONFLICT` identifies a stale acquisition fence, an occupied attempt/session id, and an owned busy transaction. no structured field separates these causes. capture review must therefore either be generic or depend on the server message.

current capture clients use generic refusal copy and explicit destination review. review rereads choices; another deliberate save uses the reviewed guards. a busy transaction or occupied id can therefore incur an unnecessary review step. no server prose is parsed and neither client claims libraries changed. an earlier unknown attempt retains its uncertainty through a later refusal.

the same edge code reaches library, collection and assistant commands. it does not prove that an object changed, remains present, or that an earlier unknown write failed. those owners need independent state evidence for such claims.

evidence: `python/nexus/services/users.py:48`; `python/nexus/services/media_source_ingest.py:341,351,358`; `python/nexus/services/media_upload_sessions.py:556`; `python/nexus/api/edge.py:97`; `apps/web/src/app/share/ShareCapture.tsx` failure projection and `apps/web/src/extension/background.ts` recovery classification and `apps/web/src/extension/popup.tsx` review projection.

resolved when the wire identifies the fence separately and both capture clients consume that structured distinction without unnecessary review. a wire change is outside the feedback-only cut.
