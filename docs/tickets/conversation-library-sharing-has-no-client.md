# conversation library sharing is server-only and unreachable

status: open (decision needed) · origin: 2026-09-17 slop sweep (claude session)
· area: conversation sharing · oi-151

`python/nexus/services/shares.py:1-171`, `api/routes/conversation_shares.py:1-71`
(GET and PUT `/conversations/{id}/shares`), the `conversation_shares` table
(`db/models.py:4678`) and the `sharing='library'` permission branches all exist,
and nothing can call them. the BFF has no catch-all (`find
apps/web/src/app/api -type d -name '[...*'` returns only
`media/[id]/assets/[...assetKey]`), and `find apps/web/src/app/api/conversations
-maxdepth 3 -type d` lists forks, tool-calls, messages, tree, context-refs and
active-path — nothing named shares. the extension makes no product API calls and
android is documented as making none; the conversations UI never exposes
sharing. about 320 lines plus one table.

decision: multi-user is planned, so this may be a surface the owner intends to
wire rather than dead weight. keep it for future wiring, or delete now and
rebuild when the UI arrives?

prerequisite: the owner's answer. if delete, confirm no restored database
carries `conversation_shares` rows worth preserving before the table goes.

fix: to keep, file nothing further and accept an unreachable server surface
until the UI lands. to delete, cut `services/shares.py`, the route module and
its registration, the `sharing='library'` permission branches, and drop the
`conversation_shares` table in the schema migration (oi-152).

acceptance: either the sharing endpoints have a client, or no sharing surface
remains without one.
