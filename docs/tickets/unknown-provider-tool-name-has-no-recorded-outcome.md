# unknown provider tool name has no recorded outcome

status: open · origin: 2026-09-17 slop sweep (claude session), svc-chat-llm SCL-03 · area: chat
tool runtime · oi-169

`RecordKind.rejected_provider_call` survives in the `record_kind` CHECK and the
decode branch, but nothing has produced it since before the sweep:
`persist_rejected_provider_tool_call` had zero callers when it was deleted.
so when the provider emits a tool call whose name is not in the frozen
catalog, the run has no dedicated recorded outcome for it; whatever the tool
runtime does today (afaict a defect fold) is the only trace.

impact: no user-facing card for a provider hallucinating a tool name; an
enum value and a CHECK member with no writer.

resolved when: either the tool runtime records a `rejected_provider_call`
step on an unknown name and the chat surfaces it, or the value is dropped
from the CHECK (migration), the enum, and `toolProjectionWire`.
