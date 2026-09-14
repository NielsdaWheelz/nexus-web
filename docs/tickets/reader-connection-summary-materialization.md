status: open
origin: 2026-09-13 bounded publication evidence cut
area: reader evidence / resource connection summaries

the existing paged connection owner still materializes unbounded values:
`resource_graph/connections.py:_note_previews` reads full NoteBlock.body_text
before taking `_PREVIEW_CHARS`; `_link_notes_for_rows` loads every matching
structural attachment into a Python map; `_expand_refs` expands all owned children.
`reader_connections.list_reader_connections` additionally loads current complete
canonical sources for live passage-anchor quote resolution. page size 100 does
not bound these allocations or preserve selected-publication coordinates.

prerequisite: bounded evidence cut must retain the existing fact/association
semantics without reusing this aggregate materialization path. move excerpts and
ownership/attachment selection into bounded SQL projections; resolve passage
locators against the selected retained generation. preserve exact authored note
and quote access through existing explicit detail owners.

acceptance: large notes, many owned children and attachment rows cannot grow a
reader summary response or Python materialization beyond the admitted page;
retained-generation source resolution never reads current complete fragments.
prove actual SQL/query shape and the existing neutral-Link note semantics.
