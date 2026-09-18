# pdf passage connections lose current locations

status: open · origin: 2026-09-17 passage cleanup, base 1bee992eb · area: reader connections

`python/nexus/services/reader_connections.py:334-365` converts a passage's pdf
location into `pdf_page_geometry` without `exact`, and with possibly empty
`quads`. `schemas/retrieval.py:433-444` requires `exact` and nonempty geometry.
`services/reader_evidence.py:763-800` catches that validation failure and marks
the connection unanchorable, even when the quote resolves to a current page.
this is separate from opening a passage link through its route.

fix the connection projection's distinction between known page position and
known geometry. reuse the passage navigation contract where appropriate; never
fabricate geometry. stored hint quads are not current merely because the quote
still matches the same page: replacement content may move glyphs within it.

acceptance: a linked pdf passage with geometry has a current anchored connection;
a page-only passage retains its known page without claiming an exact range.
verify through the document-map api and its rendered connection marker.
