# chat timeline import cycle

importing `nexus.services.chat.timeline` directly fails before its read types are
defined: `timeline.py:14` imports `chat/reads.py:47`, which imports
`tools/presentation.py:27`, which imports `tools/reads.py:38`, which imports
`MessageReadRefusal` and `read_message_page` from the partially initialized timeline.

observed in disposable librarian qualification, 2026-11-12;
`/tmp/nexus-librarian-green.log` reports `ImportError: cannot import name
'MessageReadRefusal' from partially initialized module 'nexus.services.chat.timeline'`.
normal api startup succeeds through `nexus.api.routes`' established import order.
standalone callers depend on that accidental order; the temporary driver follows
api startup while this independent defect remains open.

resolve by removing the cycle at the chat/tool contract boundary. proof: a fresh
python process can import the timeline directly, and ordinary api startup still
works. no search behavior change is required.
