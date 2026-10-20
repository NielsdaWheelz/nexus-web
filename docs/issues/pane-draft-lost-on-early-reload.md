# a chat pane's draft is lost when the page reloads before the workspace is saved

area: workspace session / chat drafts · since #681 (drafts and endpoints keyed by pane id)

problem: a chat draft lives in `sessionStorage` under its pane id
(`nx_chat_draft.v7:<account>:<pane>:<scope>`). a pane's id is durable only once the
workspace session holding it is saved (`useWorkspaceSession`: 1 s after a workspace
change, or a keepalive save on `pagehide`). a reload within about a second of opening a
pane races that save: the next bootstrap (`loadWorkspaceBootstrap` → `enterWorkspace`)
reads the older session, mints a fresh pane (`newPane`), and the draft (and a new chat's
held text) is no longer found. the pane's `?leaf` view is lost the same way.

impact: text typed into a just-opened chat pane and a reload (or a crash) in the next
second; the text stays in storage under the old pane id, unreachable.

evidence: campaign chat harness probe `harness/probe/fastreload.mjs` (2026-10-19, tip of
`cleanup/chat-web-reslice-b`): open `/conversations/new`, type, reload at once → 3 of 3
reloads came back with a different pane id and an empty composer. main behaves the same
(`apps/web/src/lib/chat/drafts.ts` keys by `viewId = runtime.paneId` since #681). the
harness journeys that reload a fresh pane now wait for the save first.

proposed fix: make a pane's identity durable before its first draft write (save the
workspace when a pane is created, or have the bootstrap keep the requested pane's id),
or key a draft by something the reload preserves.

resolved when: typing into a freshly opened chat pane and reloading at once restores the
draft in the same pane.
