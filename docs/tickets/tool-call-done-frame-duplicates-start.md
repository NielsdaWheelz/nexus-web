# tool_call_done repeats tool_call_start

status: open · origin: 2026-10-10 model tools rewrite (design §11) · area: chat wire

`services/tools/run.py` `_start` appends two frames for every call:
`tool_call_start` and `tool_call_done`, which is the same projection plus the
model's `input`. no client reads `input` or distinguishes the two (web
`lib/chat/runTail.ts` treats both as "running"), and the arguments are on the
`tool_calls` row.

proposed fix: drop `tool_call_done` from the chat wire (a chat contract bump;
`chat_run_events` CHECK loses the type).

acceptance: one start frame per call; the live line and the trail behave as
before.
