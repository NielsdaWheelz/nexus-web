# library membership changes bump the owner-only chats index

status: open · origin: 2026-10-10 chat runs rewrite (cleanup/chat-runs-reauthor) · area: library governance / chat index

chats are owner-only (`auth/permissions.py`, `visible_conversation_ids_cte_sql`),
so no library change can change any user's chats index. yet
`library_governance.bump_library_index(..., conversations=True)` bumps
`ConversationIndex` for every affected member on library deletion
(`services/library_governance.py:447`) and member removal
(`services/library_sharing.py:282-286`). a member paging their chats then gets
`409 E_COLLECTION_CHANGED` for nothing. the chat rewrite made sends and deletes
bump only their owner's revision (D6); this call is the last cross-user bump.

proposed fix: drop the `conversations` flag and its two callers' `True`.

acceptance: removing a member or deleting a library leaves every user's
`ConversationIndex` revision unchanged; the chat harness C28/C28b still pass.
