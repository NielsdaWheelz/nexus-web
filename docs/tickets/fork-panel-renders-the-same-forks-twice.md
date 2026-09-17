# the fork panel renders the same fork set twice

status: open (decision needed) · origin: 2026-09-17 slop sweep (claude session)
· area: chat fork panel · oi-146

`ConversationForksPanel.tsx:78-95` renders a two-tab tablist over one fork set,
and `:124-131` swaps `ForkGraphOverview` in for `ForkTreeView`. the graph
re-implements what the tree already provides: its own search
(`graphNodeSearchText`, 129-141), its own accessible labelling
(`graphNodeLabel`, 143-160) and its own switch action (`onSelectLeaf` ->
`branch.switchToLeaf`, `Conversation.tsx:475-477`), against
`ForkTreeView`'s `onSelectFork` / `forkSearchText` /
`deleteConfirmationDescription`. `ForkGraphOverview.tsx` plus
`ForkGraphOverview.module.css` is about 300 lines.

this is not dead code — it is a tab the owner can click today, and no doc
protects it (`rg -n 'Graph|ForkGraph|branch_graph' docs/modules/chat.md` returns
one unrelated line). deleting it removes a working view of conversation
topology, which is a product choice.

decision: keep both views of the fork set, or drop the graph?

prerequisite: the owner's answer.

fix: if the graph goes, delete `ForkGraphOverview.tsx` and its module css, the
`view` state and tablist (`ConversationForksPanel.tsx:44, 78-95`), the `view ===
"graph"` branch (124-131), and the `onSelectGraphLeaf` prop with its
`Conversation.tsx:475-477` handler. do not follow on into the wire shape in the
same change: `BranchGraph` stays fully live (`useConversation.ts:370, 558, 1346,
1405, 1413, 1487`; `useForkPanel.ts:60,97`), and narrowing `BranchGraphNode`'s
fields is a separate conversations-slice decision.

acceptance: the fork panel presents one view per fork set, or both views are
kept deliberately with the duplication recorded as intended.
