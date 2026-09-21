# `tool_call_delta` has no producer but stays in the event vocabulary

area: chat tool runtime · opened 2026-09-21 by the chat-tools reauthoring · P3

## Problem

`tool_call_delta` has had no producer since the 0217 cutover. It is still a
member of `CHAT_RUN_EVENT_TYPES`, two SQL `IN` clauses
(`chat_run_tools.bind_provider_tool_call_events`,
`chat_run_response`'s stored-event fold), the
`ck_chat_run_events_event_type` CHECK, `ChatRunToolCallDeltaEventPayload`, and
three web consumers (`sse/events.ts`, `useChatRunTail.ts`,
`useChatMessageUpdates.ts`) plus the `input` lane of `ToolCallPatch`.

## Impact

~60 dead lines across the server, the SSE schema, the database CHECK, and the
browser decoder. No user-visible behaviour.

## Why it was not removed with the rest of the sweep

Removing the literal needs an owner preflight against production data:

```sql
SELECT count(*) FROM chat_run_events WHERE event_type = 'tool_call_delta';
```

If the count is zero, drop the value from all of the above and add one
migration rebuilding `ck_chat_run_events_event_type` without it. If it is
non-zero, `chat_run_response` raises on an unknown stored type when it folds a
historical run, so deleting those rows is owner-visible data loss and needs a
decision first.

## Resolved when

The value is absent from the server vocabulary, the CHECK, and the browser
decoder, and replaying an old chat run still renders.
