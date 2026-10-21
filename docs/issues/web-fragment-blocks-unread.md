# web fragment blocks are written and never read

status: open (for the reader read half, 13b)
origin: 2026-10-20 reader python ingest re-slice (spec N10, design Q5)
area: reader python, web article structure / read model

`replace_article_fragments` writes one `fragment_blocks` row per line of a web
article (`python/nexus/services/web_article_structure.py`), but only epub blocks
feed indexing (`python/nexus/services/content_indexing.py`); nothing reads web
blocks. the write is kept: it is a persisted shape the read half owns.

impact: dead rows and write time per web publication; a future reader would
find two block grammars (epub splits at blank lines, web at every line).

resolved when the read half either reads web blocks or the web writer stops
(new rows only), with this file deleted in that change.
