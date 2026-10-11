# chat create publishes no change topic

status: open · origin: 2026-10-10 rebase of the collection-revision cut onto model tools (#561) · area: chats index

the chats index lists empty chats (`services/chat/conversations.py` `index`, no
message filter) and rereads on `Chats` (`lib/api/changes.ts`). an accepted send,
a chat delete and a message delete publish it; `POST /conversations`
(`lib/resources/resourceActionExecution.ts` `executeResourceChat`, "Chat about
this…") does not, so a chats index mounted in the same tab misses the new empty
chat until a pane return, Refresh or the first send. before the cut the create
bumped `ConversationIndex`, which only fenced continuations, so this is not a
regression.

proposed fix: `publishChange("Chats")` after the create answers.

acceptance: with the chats index mounted beside a media pane, "Chat about this…"
adds the empty chat to the index without focus.
