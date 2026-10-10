# a tool call in a turn with attached evidence trips the citation cursor

status: open · p1 · origin: 2026-10-04 chat harness baseline (C17b); 2026-10-10 graph slice harness (second turn); merged 2026-10-10 generation rewrite · area: chat tool runtime

A chat turn that carries attached evidence (a reader quote, or context a
previous turn left on the chat) records it as tool call 0 with candidates
`1..k` (`persist_attached_citations`), so `chat_run_worker._initial_citation_ordinal`
is `k+1`. Any later tool call asks `_starting_citation_ordinal`
(`python/nexus/services/tool_runtime/chat_projection.py`) for the max ordinal of
earlier calls; that counts call 0 (`k < k+1`) and raises `AssertionError: Chat
citation candidate cursor is malformed`. The two reported shapes are this one
cause: a first turn with a quote whose model searches (C17b), and a second turn
whose model calls a tool in a chat with attached context (graph harness C1 C6,
`fake:tool fake:cite where does it nest?` sent twice).

behaviour on the rebased generation rewrite: the generation closes `defect`,
the assertion escapes into the job's retry, and the retry finds the started
generation and fails the run `error`/`interrupted` (a failure card with Rerun)
within about 30 s. before the rewrite each attempt failed, the job dead-lettered
after three, and the run stayed "Response paused" forever. either way the answer
is lost.

impact: any tool use in a turn with attached evidence fails the answer.
evidence: C17b XFAIL in every chat harness run since 2026-10-04; 2026-10-10 chat
harness on the rewrite rebased onto `00a5cac3a` (generation/rebase-final-chat-run.txt);
graph slice harness worker log `chat_run_failed_unexpected`, runs `complete,running`
on unchanged `36e43224b` and on the graph rewrite.

fix: start the cursor at the attached cursor, not at an earlier tool: exclude
call 0 from `_starting_citation_ordinal`'s max (or compare against the attached
cursor), in the chat runtime's owner.

resolved when: C17b passes (the run completes and cites both the quote and the
search hit) and a second cited turn in a chat with attached context completes,
numbering its tool citations after the attached ones.
