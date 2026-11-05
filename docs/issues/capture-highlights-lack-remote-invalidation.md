# capture highlights lack remote invalidation

problem: capture-only highlights have no remote evidence-lane writer.

evidence at `41b6872a1`, source review only:
`python/nexus/services/highlights.py:244-246` skips highlights without
`anchor_media_id`; x-capture fragments have no media owner.
`services/reader_document_map.py:349-355` reads a fragment annotation lane.

impact: another client's highlight changes may leave a mounted capture map stale.
local authored refresh can hide the gap. no runtime reproduction yet.

resolved when: the highlight owner invalidates the readable capture fragment's
evidence lane and two real clients observe changes without reopening. citation
completion's new fragment-lane writer does not resolve highlight changes.
