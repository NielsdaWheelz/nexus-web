# a tool call that never completes keeps its row `Prepared`

status: open · origin: 2026-10-10 generation rewrite review (finding 5) · area: chat tool runtime

`llm_tool_positions` rows are written `Prepared` before a call runs and become
`Completed` only with the handler's effects (`ToolPositionRecorder.terminalize_and_settle`,
`python/nexus/services/tool_authority.py`). two paths end a call without that
commit, so its row stays `Prepared` for good:

- a codex stop cancels the kernel's in-flight callback task
  (`llm_agent_kernel/native.py`, `stop()`), so `CancelledError` unwinds through
  `execute_canonical`;
- the tool fence refuses the call (`ToolAuthorityRefused` after a stop, a lost
  claim or a closed generation), at the handler's authorization or a write's commit.

impact: none observed. nothing reads `Prepared` rows (`live_write_count`,
receipts, undo and Details read `Completed` only), a refused or cancelled call
commits no effect, and `finalize_run` settles the call's `message_tool_calls` row.
the cost is that design invariant I2' ("the row is completed") does not hold, and
migration 0269 step 4 cleaned such rows once while nothing cleans new ones.

proposed fix (tools slice, with its `replay_status` rename): either name the
state (`Abandoned`, written by a shielded close on `CancelledError` and
`ToolAuthorityRefused`, without the chat projection), or document `Prepared` as
the terminal state of a call that never completed.

acceptance: after a codex stop during a tool call (harness G05 with a tool) and
after a write refused at commit, the call's row is in a named terminal state, or
the tools contract states that `Prepared` is one.
