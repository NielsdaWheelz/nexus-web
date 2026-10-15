# chat create has no client id

problem: `POST /conversations {initial_context_refs}` carries no client-minted id, so a
create is not idempotent. "Chat about this…" (menu and the media pane's chat key) and the
other create callers can only guard against a second request while the first is in flight.

impact: a retry after an unknown outcome (a transport failure after the server committed)
makes a second, empty chat about the same resource.

evidence: `apps/web/src/lib/chat/conversationIndex.ts` `createConversationAbout` (in-flight
guard per ref only); `python/nexus/api/routes/chat.py` `create_conversation` takes only
`initial_context_refs`, and `conversations.create` mints the id.

fix: a client-minted conversation id on `POST /conversations` for every caller, inserted with
`ON CONFLICT (id) DO NOTHING` (another owner's row → 409), per the campaign idempotency rule.

resolved when: every create caller sends its own id and a replayed create returns the same
conversation.
