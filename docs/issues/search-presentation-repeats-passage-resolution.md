# search presentation repeats passage resolution

status: open follow-up; not an additional release gate pending the affected journey.

on `dbc919b5`, `search/indexed.py:present` calls `resource_items_out` once per
reading-context batch. `resource_items/items.py:_rows` resolves `media_passages`,
then `resource_items/routing.py:resource_activations_for_refs` resolves them again.
before that second resolution, routing's `_dynamic_routes` also calls
`locations.current_passages` for chunks, spans and oracle anchors; its media
results are subsequently replaced. `locations.media_passages` itself calls
`current_passages`, which resolves authorized reading owners through
`scoped_media_passage`. these paths repeat passage and reading-scope work.

the private completed instrumented diagnostic records 228 presentation sql
statements, including 58 source-kind statements with 20 distinct bindings,
55 fragment statements with 19 bindings, and 38 visibility statements with
19 bindings. instrumentation and diagnostic completion do not establish actual
api elapsed time or the repeated work's share of latency. evidence remains in
`search-release-integration/membership-diagnostics/remote/completed-semantic.private.json`.

pass hydration's already resolved authorized passage facts to the activation
owner within the same viewer, reading context and read transaction. preserve
standalone routing resolution, missing-ref suppression, note-owned passage
routes, selected reading, bounded literal evidence and canonical activation.
avoid session/global caches or lifecycle machinery.

resolved when one presentation batch resolves each media passage once per
reading context, while restricted-piece evidence boundaries, unavailable refs,
standalone and note-owned routes, and canonical activation remain correct.
