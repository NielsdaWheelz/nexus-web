# chat publication and deletion invert their locks

status: open
origin: 2026-10-16 resource presentation audit; origin/main ff57128842b470510446b3edca54922ebcace41e
area: chat publication, context, deletion

publication takes the run and job locks (`python/nexus/services/chat/worker.py:149`), then obtains the conversation lock while attaching citations (`services/chat/citations.py:201`, `services/resource_graph/edges.py:271`). deletion holds the conversation lock (`services/chat/conversations.py:182`, `:198`), waits for the job during revocation (`:238`, `jobs/queue.py:510`), and deletes messages whose cascades remove runs (`services/chat/conversations.py:259`). publication can therefore hold the job while waiting for the chat that deletion holds while waiting for that job. live run-to-job event writers also conflict with deletion's job-to-run cascade.

establish conversation, run, job order for publication and deletion; lock affected runs before revoking their jobs. preserve the run-then-job suffix for streaming. apply the same order when adding the context-edit guard. a database abort during final publication risks losing an already-generated response because the worker does not replay generation.

resolved when controlled interleavings of publication, deletion and event append finish without deadlock while deleted runs cannot publish. this is a source-proven lock cycle; no live reproduction was run.
