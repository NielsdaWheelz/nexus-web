# two headers gate a stale chat tab

status: open · origin: 2026-10-10 model tools rewrite (design §11) · area: chat wire

the browser sends `X-Nexus-Chat-Contract` (`apps/web/src/lib/api/client.ts`) and
`X-Nexus-Tool-Projection` (the generated `lib/chat/toolContractProjection.ts`) on
the same chat paths, and `api/deps.py` checks both with the same 409 "Reload
Nexus to continue". the tool projection revision is a hash of the tool
vocabulary the browser decodes; it could feed the chat contract revision instead.

proposed fix: fold the projection revision into one chat contract value (one
header, one check), keeping the generator so a vocabulary change still forces a
reload.

acceptance: one header gates every chat path; a vocabulary change still reloads
an open tab.
