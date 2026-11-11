# chat recovery erases known generation failure

at production source `3d81ef45ef28f637a4de07c66ab172bbab9e22c2`, schema `0317`,
on 2026-10-29, generation `ca167d96-7183-4f7a-b1c1-6d53cad9b0aa` closed at
20:41:54.523 utc with `failure_code=defect`, `detail=OperationalError`, after
postgres memory exhaustion. its run `e8190fe8-7898-4ac2-a352-9c6300325a25`
closed at 20:42:24.659 with `error_code=interrupted`, `support_id=null`.
the known defect was presented as assistant unavailability with rerun.

the current cause remains in `python/nexus/services/chat/worker.py:104-106`:
a prior generation leads to `events.finalize_dead`. `events.py:156-162` ignores
its terminal and writes an empty interrupted answer. committed text frames would
also be discarded; this incident had none, so partial-text loss is a source
finding, not an observed loss here.

repair chat settlement: preserve known terminal failure and generation
correlation, and reserve interruption for execution without a known outcome.
recover committed partial text using existing citation cleanup without replaying
model or tool work. resolve when the saved failure, card, details and recovery
policy agree after worker failure and reload, with one terminal event and
preserved history.
