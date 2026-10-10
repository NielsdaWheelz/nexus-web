# a second chat turn with attached evidence and a tool call never finishes

status: open · origin: 2026-10-10 graph slice harness (reproduced on unchanged main `36e43224b`) · area: chat / tool runtime

in a chat whose context holds attached evidence, a second turn whose model calls a
tool fails every attempt with `AssertionError: Chat citation candidate cursor is
malformed` (`python/nexus/services/tool_runtime/chat_projection.py`
`_starting_citation_ordinal`) and the run is suspended after three attempts; the
reader shows "Response paused. Its outcome is unconfirmed." the attached-context tool
call (index 0) numbers candidates `1..k` and `chat_run_worker._initial_citation_ordinal`
starts tools at `k+1`, but `_starting_citation_ordinal` takes the max ordinal over
every earlier tool call, index 0 included, and raises when it is below `k+1` (always,
when only the attached call precedes).

reproduce: graph harness, `run.sh C1 C6` with the ui version of C6
(`fake:tool fake:cite where does it nest?` sent twice in C1's chat); worker log
`chat_run_failed_unexpected`, runs `complete,running`. same on the reauthored tree.

fix: exclude the attached call (or compare against the attached cursor, not the
initial ordinal) in `_starting_citation_ordinal`, in the chat runtime's owner.

done when: a second cited turn in a chat with attached context completes and numbers
its tool citations after the attached ones.
