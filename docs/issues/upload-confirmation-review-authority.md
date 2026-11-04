# upload confirmation review needs an authoritative refusal

confirmation can receive409 `E_RESOURCE_CONFLICT` before resolving a published
receipt. the same code identifies a real acquisition-fence refusal, so it cannot
by itself authorize rewriting frozen confirmation bytes. this is stronger than
the descriptive ambiguity in `capture-conflicts-share-one-code.md`.

evidence at feedback-homes a7dcd4898: `python/nexus/auth/middleware.py:99-105`
rethrows bootstrap `DatabaseBusyError` before the route; `api/edge.py:93-99`
maps it to the generic conflict. `services/media_upload_sessions.py:717-721`
takes publication locks before its second receipt check. its earlier `_owned`
call uses `lock=False`; an earlier held import source had a different first
lookup, so that source's initial-row-lock claim does not qualify this head.
all three python paths are under `python/nexus/`.

`apps/web/src/lib/imports/ingest.ts` already keeps
`confirmation_unsettled` through nonterminal refusals and blocks explicit review
while it remains true. preserve that protection in imports, note attachments
and connection attachments. the first generic conflict remains ambiguous;
clearing an import owner's unanswered flag merely because review is offered
would not establish that its previous confirmation never published.

the owner accepted existing503 `E_DATABASE_BUSY` at the confirmation and ordinary
auth-bootstrap owners, leaving global edge and worker retry behavior unchanged.
the import owner reports the repair at local `a3401e795`, with confirmation
lock-timeout and receipt/control journeys qualified. ordinary auth-bootstrap
contention now has managed chromium evidence: 409 at `1700eb82e`, then 503
with identical frozen bytes and one recovery guard at the repair. the bootstrap
proof excludes firefox, 426, the installed app and post-cut composition.
the branch is held for the feedback-homes cut and is not composed here, so its
runtime evidence does not qualify this head's protocol behavior.
resolve with a distinct authoritative review boundary and all shared/capture
consumers composed, proving exact bytes and uncertainty survive a technical
failure before receipt lookup, while a real receipt settles normally and a
qualified fence still permits review. this head has source evidence of the gap, not a reproduced
race or a claim of duplicate server publication.
