# workspace teardown can reach the api without its body

status: open; live response observed, user state loss unverified
origin: 2026-10-13 add/import isolated verification at 16763c3cd4
area: web / workspace persistence

closing disposable chromium contexts produced `PUT /me/workspace-session`
400 responses with `loc: ["body"], msg: "Field required"`. evidence:
historical receipt `nexus-web-campaign-artifacts/2026-10-13/add-import/evidence/workspace-unload.txt`
(owner-retired on 2026-10-22; file unavailable)
(request `b69f916e-6f30-4b15-9b2b-83b8b14d0b52`, 22:26:54 utc).
`apps/web/src/lib/workspace/useWorkspaceSession.ts:42` sends the keepalive save;
`apps/web/src/app/api/me/workspace-session/route.ts:27` forwards it to the api.

reproduce a dirty workspace followed by real tab close/reload; distinguish browser
cancellation from proxy body handling. repair the responsible save/forwarding owner
if the user's last workspace is lost. keep this separate from add/import's editor.

2026-10-21 (pane chrome re-slice): the hide flush uses keepalive only while the
body fits the browser's 64 KiB budget, else an ordinary request
(`useWorkspaceSession.ts`). chromium refuses a keepalive fetch over the budget
outright (`TypeError: Failed to fetch`, a 75 KB body), so before this a larger
state's hide flush always failed; the ordinary request lands when the page only
hides. browser-limit case: no request over the budget survives an unload, so a
larger state still loses a change made within the 1 s debounce before a close
or reload (harness: a 75 KB workspace, a change, then a close: lost, 2 of 2;
the change then a dispatched pagehide: saved). saving such a state at once on
every change instead narrows the window to one round trip but multiplies its
writes (4 changes in 1.1 s sent 4 PUTs, 301 KB, against 1; a resize drag
commits per pointermove); not adopted without a ruling. no stored row exceeds
64 KiB (census 2026-10-21: max 10,123 bytes). the empty-body 400 above is a
separate symptom and is unchanged.

acceptance: the terminal save either reaches the api with the intended snapshot or
retains a correctly classified retry; reopening restores the last acknowledged
workspace. record any browser-limit case explicitly.
