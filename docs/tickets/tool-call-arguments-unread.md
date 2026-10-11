# tool_calls.arguments has no reader

status: open · origin: 2026-10-10 model tools rewrite (decision T1, design §8) · area: chat tool runtime

T1 names the call's arguments as part of the one record, so `run_tool` writes
`tool_calls.arguments` (null when the transport refused them), but nothing reads
the column: the trail, history, authorship and undo use `result` and
`created_refs`. migration `0274` copied old positions' arguments.

proposed fix: give it a reader (Details could show a call's input) or drop it.

acceptance: the column is read by a product surface, or gone.
