# a tool call in a quoted chat trips the citation cursor

status: open · origin: 2026-10-04 chat harness baseline (C17b) · area: chat tool runtime

A chat turn that carries a reader quote records the quote's evidence as tool
call 0 (citation ordinal 1), so `_initial_citation_ordinal` is 2. Any later
tool call asks `_starting_citation_ordinal`
(`python/nexus/services/tool_runtime/chat_projection.py:327-343`) for the max
ordinal of earlier calls, which counts call 0 (1 < 2) and raises "Chat citation
candidate cursor is malformed". The first attempt fails after durable dispatch,
retries find no native recovery evidence, the job dead-letters, and the run
stays running/suspended: "Recovering response", then "Response paused" with no
action.

impact: any tool use in a quoted chat leaves the answer paused forever.
evidence: harness C17b XFAIL in the baseline and after the chat rewrite
("run running after 90 s; tool calls attached:complete,nexus.search:complete").

resolved when: the cursor treats the attached evidence as the initial ordinal
(not as an earlier tool), C17b passes (the run completes and cites both the
quote and the search hit), and a suspended run of this shape is settled.
