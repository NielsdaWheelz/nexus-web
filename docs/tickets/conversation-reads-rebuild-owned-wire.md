# conversation reads rebuild owned wire shapes

status: deferred; source-verified, runtime not_run · origin: 2026-10-04 reduction discovery, main `bbfd1df4` · area: chat reads

`apps/web/src/lib/conversations/messageWire.ts:82–148,200–313,350–460` repeats chat-run, trust-run and folded-stream field sets, enums and object reconstruction. the canonical owners already build `ChatRunResponse` (`python/nexus/services/chat_run_response.py:74–123`), `MessageOut` (`python/nexus/services/conversations.py:158–201`) and `ConversationTreeOut` (`python/nexus/services/conversation_branches.py:224–293`). direct callers are `apps/web/src/components/chat/useConversation.ts`, `apps/web/src/components/chat/useChatRunTail.ts` and `apps/web/src/lib/conversations/chatAdmissionRead.ts`.

this is duplicated contract ownership, not an observed user defect. the 476-line module also carries real reader-selection branding/camel conversion. `apps/web/src/lib/conversations/trustToolCallWire.ts` enforces count/ref/effect correlations; its machine-authorship and persisted/native boundaries are not blanket deletion candidates.

prerequisites: finish the public-sse slice; inventory every read/cancel/repeat/tree envelope and optional key against its actual producer. expose existing models at those route boundaries, use generated types, and retain small domain conversions plus acknowledged-read identity checks. keep the separate [release-pairing issue](chat-contract-release-pairing.md) open.

acceptance: complete valid response/domain parity on saved quoted and unquoted messages, trust/citation details, tree/fork reads and reconnect folding; ordinary browser reload preserves rendered history and selection. retain canonical reader keys and trust correlations. run the sole static gate. qualify malformed-output diagnostic changes and production/native/provider work separately.
