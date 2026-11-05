# large chat deletion materializes the whole subtree

problem: `services/chat/conversations.py::_delete` collects every message id,
run id and retained-source id before deletion (lines 315–387 at `eb6ed2def`).
it then passes whole arrays into locking and cleanup queries. this existing
path scales with the deleted subtree while holding the account deletion fence
and chat lock. the bounded prompt-preparation change does not bound deletion.

impact: sufficiently large deletion can consume application memory and delay
fresh chat creation. no production deletion failure was observed in this audit.

resolve with set-based subtree membership and bounded owner-ordered cleanup that
preserves generation/job/media lock order, cancellation and atomic fence
advancement. prove large real subtree deletion under existing limits, concurrent
creation fencing, and complete source/job cleanup.
