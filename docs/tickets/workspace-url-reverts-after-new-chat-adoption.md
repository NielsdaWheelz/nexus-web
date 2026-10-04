# workspace url reverts after a new chat is admitted

status: open · origin: 2026-10-04 mounted chat old proof · area: workspace / chat

a new-chat send receives a real accepted run. `Conversation.tsx` adopts it and calls the pane router's `replace` with the admitted conversation and assistant ids. the active pane keeps its id and renders the admitted prompt and terminal answer, and its persisted `currentVisit.href` is the admitted conversation url. the browser address bar first shows that url, then returns to `/conversations/new`.

impact: the address bar names a new-chat destination while the active pane owns an existing conversation. copied or reloaded navigation could therefore target the wrong resource; that downstream behavior has not been exercised.

evidence: the task-only mounted response, active-pane and terminal observations, plus the native `workspace_sessions` read, were frozen in the 2026-10-04 conversation old packet. `apps/web/src/components/chat/Conversation.tsx:413–424` initiates the replacement; `apps/web/src/lib/workspace/store.tsx:765–772, 1238–1280` projects the active visit to the url. the persisted active visit had `/conversations/a3c73a74-c47d-4a82-a0a6-92c9c44ae314?message=20b74cd4-15c5-4a20-a5f7-bb9de113cc9c` while the same mounted active pane and nexus current tab were at `/conversations/new`. the exact browser/history race remains unqualified; no remount was observed.

resolved when: a native-accepted new-chat send leaves the active pane, persisted visit, and stable address bar on the same admitted conversation target, including after the render settles. prove copied/reloaded navigation reaches that conversation before claiming that consequence repaired.
