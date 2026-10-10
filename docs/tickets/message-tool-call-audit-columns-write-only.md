# message_tool_calls audit columns are written and never read

status: open · origin: 2026-10-10 chat runs rewrite (cleanup/chat-runs-reauthor) · area: chat tool runtime (tools slice)

after the chat rewrite nothing reads eight `message_tool_calls` columns that every
tool call still writes: `requested_types`, `selected_context_refs`,
`provider_request_ids`, `latency_ms`, `search_query_fingerprint` (written by
`services/chat/tool_calls.finish`) and `canonical_input_sha256`,
`tool_contract_revision`, `binding_policy_revision` (written by
`tool_calls.start`). the trust trail and the Undo response read only the
projection fields, `status`, `result_refs`, `reverted_at` and the retrievals; the
web never read the others (the trust wire dropped them, design §3). their producer
is `ToolAuditProjection` in `tool_authority.py`, and the planned merge of the four
tool records belongs to the tools slice, so the chat rewrite kept writing them.

prerequisites: the tools slice decides the one durable tool record.

proposed fix: in the tools slice, stop producing these facts (or give them a
reader), and drop the columns in that slice's migration.

acceptance: every `message_tool_calls` column has a reader, or is gone; the chat
harness still passes C14, C17, C25 and C26.
