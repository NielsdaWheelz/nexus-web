# rapid chat path choices can persist out of order

status: open
origin: 2026-10-16 chat viewer source audit
area: web / chat / mutation ordering

`apps/web/src/components/chat/conversationStore.ts:249-256` immediately selects
a leaf locally, then independently posts it. fork controls remain enabled
(`apps/web/src/components/chat/Forks.tsx:50-57`). the server serializes choices
by conversation-lock acquisition, without client intent ordering
(`python/nexus/services/chat/conversations.py:136-158`). rapid choices a then b
can arrive and commit b then a, while the browser continues displaying b.
this is a source-established race, not a reproduced production incident.

impact: reload can restore a different path from the last choice the user saw.
faster local branch controls make this existing hazard more salient.

coordination evidence: stores are per mounted pane
(`conversationStore.ts:413-418`), while sends belong to `lib/chat/drafts.ts`.
an accepted send clears draft pending state at `:120-127` before the screen
starts asynchronous leaf adoption (`Conversation.tsx:245-254`,
`conversationStore.ts:241-246`). a store-local busy flag or a gate covering
only the post cannot coordinate every writer or that adoption gap.

approved scope, 2026-10-16: protect duplicate panes and concurrent tabs/devices
with a server-owned monotonic revision; stale competing writes fail visibly.
there is no live cross-tab synchronization. follow the no-ledger convention;
generation creation/recovery and draft persistence remain separate work.

prerequisites: define ordering against other operations that select the leaf.
keep one owner for active-path writes per conversation and serialize admitted
intent, or temporarily disable switching while saving and state that latency
tradeoff. keep failed/uncertain writes from being silently overwritten.
gate both directions against sends, repeats and deletion, through canonical
adoption/reconciliation, without locking for the full streamed generation.
specify whether coordination covers one pane, the tab's duplicate panes or
multiple clients. prove handling of delayed old writes after uncertain
delivery; a fresh read alone is not a fencing guarantee.

acceptance: delayed first/second requests and rapid opposite choices leave the
visible and reloaded path at the last accepted intent. failure and uncertain
delivery preserve an explicit recovery path. verify interactions with send,
regenerate and deletion, which can also move the leaf.
