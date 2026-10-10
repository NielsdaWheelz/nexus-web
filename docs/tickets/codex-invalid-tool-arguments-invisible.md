# codex tool calls with invalid arguments leave no record

status: open · origin: 2026-10-10 generation rewrite (design T7) · area: chat tool runtime / codex

under the kernel's transient native mode a codex callback whose arguments fail
validation is answered by the kernel with a typed rejection and never reaches
the host's dispatch port; a repeated native call id is answered from the
kernel's memory the same way. neither leaves an `llm_tool_positions` row or a
`message_tool_calls` row, so the chat trust trail and Details do not show the
attempt. provider proposals with invalid JSON still record a failed row
(`GenerationToolExecutor._refuse_arguments`). before the rewrite the durable
native journal recorded codex rejections; one harness case (C14b) also left
such a row stuck `running`.

prerequisite: a kernel port that reports rejected and replayed callbacks, or an
owner decision that they stay invisible.

proposed fix: emit a host-visible event from the kernel for each rejected
callback and project it as an `error` tool row.

acceptance: a codex callback with invalid arguments shows in the chat's tool
list as an error, on both routes alike.
