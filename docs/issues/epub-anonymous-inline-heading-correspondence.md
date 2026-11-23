# anonymous inline epub headings lack retained correspondence

an inline heading such as `<span role="heading" aria-level="2">title</span>`
without an id or a captured structural element can remain readable without a
contents jump. the source declaration is explicit, but the retained projection
cannot assign a unique rich edge.

`canonicalize.py:183` captures structural elements and named targets.
`epub_structure.py:159` binds source semantics to those retained elements.
a named inline heading now binds through its unique retained id. capturing every
inline styling span would expand the structure budget for ordinary books.

resolve when a declared anonymous inline heading binds to its exact retained
start, even beside equal text. validate unchanged fragment bytes, text, and
existing rich cuts. an ordinary styled span must still add no heading.
