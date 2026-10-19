# workspace url reverts after a new chat is admitted

status: open · origin: 2026-10-04 mounted chat old proof · area: workspace / chat

a new-chat send receives a real accepted run. `Conversation.tsx` adopts it and calls the pane router's `replace` with the admitted conversation and assistant ids. the active pane keeps its id and renders the admitted prompt and terminal answer, and its persisted `currentVisit.href` is the admitted conversation url. the browser address bar first shows that url, then returns to `/conversations/new`.

impact: the address bar can name a new-chat destination while the active pane owns an existing conversation. copied or reloaded navigation could therefore target the wrong resource. the historical divergent address was not copied or reloaded.

evidence: the task-only mounted response, active-pane and terminal observations, plus the native `workspace_sessions` read, were frozen in the 2026-10-04 conversation old packet. `apps/web/src/components/chat/Conversation.tsx:413–424` initiates the replacement; `apps/web/src/lib/workspace/store.tsx:765–772, 1238–1280` projects the active visit to the url. the persisted active visit had `/conversations/a3c73a74-c47d-4a82-a0a6-92c9c44ae314?message=20b74cd4-15c5-4a20-a5f7-bb9de113cc9c` while the same mounted active pane and nexus current tab were at `/conversations/new`. the exact browser/history race remains unqualified; no remount was observed.

bounded follow-up at `78b398f0caf1828c99cf3234baea1135eda7c3a2`: two genuine new-chat admissions used one isolated local account/database, a temporary read-only typed native catalog, and controlled completed journal memos published through the actual claimed-job, fingerprint and run/job fence owners. both runs completed with succeeded jobs; provider/tool dispatch tables and outbound http remained empty. the first control traversed nexus history before completion, which may have aligned next's address state. the second began at a fresh `/conversations/new` document and completed without any overlay or history traversal. its pre-hydration instance/prototype wrappers recorded exactly the initial next replacement and workspace adoption, with no later writer. address, active pane and persisted active visit stayed on conversation `fe08ec4d-880a-4626-99df-768cfc686360`, run `9e46f3bf-9d9e-4a07-a842-3d6a54aed4cd`; copying and reloading that admitted href retained the same destination and controlled terminal text. this is controlled output, not model execution or a physical-device claim.

source witnesses: workspace store `abff5075b716d247a880dd566b18945ac848d4127d90bf453e883f0b0f33bce2`, history dismissal `89ac1b2b137e5b352992fc64c9988bb2ed30b76617d32d0bdfa6deb7d20efaff`, nexus events `be3e253456aaccf8f887485d7df426fac1d70fc2a0372f3a89b7fac684a9c3a1`. the independently read cause receipt is `df4c67ac107a6e5298bc6a459eefcd92c87f6816af6e0966078e739cbf2fc916`; reload/provenance addendum `4c6d9930178ac096cbaabb1b21ae2f9e691e0f9db2ea58f38a60da87ecb41c36`. the fourteen frozen observations and executed helpers matched their hashes. the cumulative catalog diagnostic changed during reload; its original snapshot is unavailable and the later read-only counts are recorded separately. temporary raw/helpers were deleted after independent review.

blocker: neither bounded control reproduced the historical overwrite. the source-supported next canonical-url hypothesis remains a hypothesis. no workspace product change was made; stable controls do not resolve this ticket.

resolved when: qualify the historical overwriting call or an equivalent failing ordering, repair its responsible owner, and show the same ordering leaves the active pane, persisted visit and settled address on the admitted target. include copied/reloaded navigation and relevant overlay/history transitions in that repaired case.

2026-10-04 chat rewrite: new-chat adoption still calls the pane router's
`replace` (`apps/web/src/components/chat/Conversation.tsx`, `onAccepted`), now
with `{ activate: false }`. the race is not claimed fixed.

2026-10-09 workspace reauthoring (cleanup/workspace-reauthor): the store now
projects the address through next's patched `history.replaceState(null, "",
href)`, so next's router url (`canonicalUrl`) follows every projection,
including the first one after hydration (re-projected on the next frame once
next has installed its patch). the source-supported hypothesis above — next
re-asserting a stale canonical url on a later app-router commit — is therefore
removed by construction, and harness journeys L2.address-survives-server-action
and L2.cold-resume-address-survives-server-action (server actions after an
in-pane navigation and after a cold resume) pass. the new-chat ordering itself
was not replayed (the harness runs no model).
