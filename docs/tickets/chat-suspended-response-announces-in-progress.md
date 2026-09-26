# suspended chat response still announces work in progress

status: local fix; authenticated browser proof pending · origin: 2026-09-25 chat recovery review · area: chat accessibility and state presentation

`apps/web/src/components/chat/useConversation.ts:1373-1379` maps every pending
assistant to `AssistantRunning`, ignoring its execution advisory.
`ChatComposer.tsx:135-136` then announces that the response is in progress.
the assistant row correctly renders a paused response when execution is
suspended (`AssistantMessage.tsx:97-103,141-146,193-194`).

the user confirmed the paused card for the investigated production run. the
row spinner is not an established defect; the composer contradiction is
source-confirmed. retaining the block on new sends may be correct while work
is unresolved, but describing suspended execution as running is not.

derive truthful composer feedback from the existing execution owner without
duplicating run state. preserve draft editing and safe send gating; cancellation
correctness is tracked [separately](chat-cancel-uncertain-codex-requeues-without-settlement.md).

acceptance: a suspended response has consistent paused/recovery wording in the
assistant row and accessible composer status; it does not advertise active
generation or silently authorize another send.
