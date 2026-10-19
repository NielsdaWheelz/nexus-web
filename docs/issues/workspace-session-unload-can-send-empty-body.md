# workspace teardown can reach the api without its body

status: open; live response observed, user state loss unverified
origin: 2026-10-13 add/import isolated verification at 16763c3cd4
area: web / workspace persistence

closing disposable chromium contexts produced `PUT /me/workspace-session`
400 responses with `loc: ["body"], msg: "Field required"`. evidence:
[isolated response receipt](../../../nexus-web-campaign-artifacts/2026-10-13/add-import/evidence/workspace-unload.txt)
(request `b69f916e-6f30-4b15-9b2b-83b8b14d0b52`, 22:26:54 utc).
`apps/web/src/lib/workspace/useWorkspaceSession.ts:42` sends the keepalive save;
`apps/web/src/app/api/me/workspace-session/route.ts:27` forwards it to the api.

reproduce a dirty workspace followed by real tab close/reload; distinguish browser
cancellation from proxy body handling. repair the responsible save/forwarding owner
if the user's last workspace is lost. keep this separate from add/import's editor.

acceptance: the terminal save either reaches the api with the intended snapshot or
retains a correctly classified retry; reopening restores the last acknowledged
workspace. record any browser-limit case explicitly.
