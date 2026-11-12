# interrupted chat cannot automatically continue

open, separately deferred capability. `python/nexus/services/chat/worker.py:98`
ends a run when a prior generation exists. `generation/ledger.py:70` records a
terminal audit result; it does not persist accepted turns and decoded output
sufficient for continuation. interrupted chats are not promised to finish
automatically.

tools can write. removing the existing guard would permit duplicate effects.
continuation needs durable accepted turns before tools, stable invocation
identity, atomic local effect receipts, and final output before publication.
uncertain native or external writes require authoritative reconciliation. reuse
the existing generation, tool and kernel owners.

resolve when cross-process continuation after committed tool effects preserves
text, cancellation and effect identity without repeating an uncertain external
write. this capability remains unqualified. the librarian cutover preserves
committed partial text and known failures without resubmitting the original turn.
